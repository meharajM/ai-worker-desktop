use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{ipc::Channel, State};

const MAX_RUNS: usize = 4;
const MAX_RUN_ID: usize = 64;
// LangGraph merges message updates by provider message ID, so each fixture response
// uses its already validated native run ID to keep separate assistant turns distinct.
const NORMAL: &[&[u8]] = &[
    b"data: {\"id\":\"proof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"caf\xc3",
    b"\xa9\"},\"finish_reason\":null}]}\n\n",
    b"data: [DONE]\n\n",
];
const ERROR: &[&[u8]] = &[
    b"data: {\"id\":\"proof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
];
const TOOL_CALLS: &[&[u8]] = &[
    b"data: {\"id\":\"proof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"proof_fixture_action\",\"arguments\":\"{\\\"action\\\":\\\"first\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
    b"data: {\"id\":\"proof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"proof_fixture_action\",\"arguments\":\"{\\\"action\\\":\\\"second\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
    b"data: {\"id\":\"proof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
    b"data: [DONE]\n\n",
];

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofScenario {
    Normal,
    Error,
    Abort,
    ToolCalls,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureAction {
    First,
    Second,
}

#[derive(Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
#[serde(rename_all_fields = "camelCase")]
pub enum ProofEvent {
    Chunk {
        run_id: String,
        bytes: Vec<u8>,
    },
    Complete {
        run_id: String,
    },
    Failed {
        run_id: String,
        message: &'static str,
    },
    Aborted {
        run_id: String,
    },
}

#[derive(Default)]
pub struct ProofState {
    runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl ProofState {
    fn insert(&self, id: &str, stopped: Arc<AtomicBool>) -> Result<(), &'static str> {
        let mut runs = self.runs.lock().map_err(|_| "proof state unavailable")?;
        if runs.contains_key(id) {
            return Err("duplicate run id");
        }
        if runs.len() >= MAX_RUNS {
            return Err("too many active proof runs");
        }
        runs.insert(id.to_owned(), stopped);
        Ok(())
    }

    fn cancel(&self, id: &str) -> Result<bool, &'static str> {
        let runs = self.runs.lock().map_err(|_| "proof state unavailable")?;
        if let Some(stopped) = runs.get(id) {
            stopped.store(true, Ordering::Release);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn remove(&self, id: &str, stopped: &Arc<AtomicBool>) {
        if let Ok(mut runs) = self.runs.lock() {
            if runs
                .get(id)
                .is_some_and(|current| Arc::ptr_eq(current, stopped))
            {
                runs.remove(id);
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn proof_stream(
    run_id: String,
    scenario: ProofScenario,
    on_event: Channel<ProofEvent>,
    state: State<'_, ProofState>,
) -> Result<(), String> {
    if !valid_run_id(&run_id) {
        return Err("invalid run id".into());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    state
        .insert(&run_id, stopped.clone())
        .map_err(str::to_owned)?;
    let runs = state.runs.clone();
    let id = run_id.clone();
    let worker_stopped = stopped.clone();
    let spawn = thread::Builder::new()
        .name("tauri-proof-stream".into())
        .spawn(move || {
            let state = ProofState { runs };
            let mut send = |event| on_event.send(event).map_err(|_| ());
            produce(&state, &id, &worker_stopped, scenario, &mut send);
        });
    if spawn.is_err() {
        state.remove(&run_id, &stopped);
        return Err("could not start proof stream".into());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn proof_cancel(run_id: String, state: State<'_, ProofState>) -> Result<bool, String> {
    state.cancel(&run_id).map_err(str::to_owned)
}

#[tauri::command]
pub fn proof_fixture_action(action: FixtureAction) -> &'static str {
    match action {
        FixtureAction::First => "fixture:first",
        FixtureAction::Second => "fixture:second",
    }
}

fn produce(
    state: &ProofState,
    id: &str,
    stopped: &Arc<AtomicBool>,
    scenario: ProofScenario,
    send: &mut impl FnMut(ProofEvent) -> Result<(), ()>,
) {
    let chunks = match scenario {
        ProofScenario::Normal | ProofScenario::Abort => NORMAL,
        ProofScenario::Error => ERROR,
        ProofScenario::ToolCalls => TOOL_CALLS,
    };
    let fail = matches!(scenario, ProofScenario::Error);
    let abort_after_first = matches!(scenario, ProofScenario::Abort);
    let mut channel_open = true;
    let mut terminal = None;

    for (index, bytes) in chunks.iter().enumerate() {
        if stopped.load(Ordering::Acquire) {
            terminal = Some(ProofEvent::Aborted {
                run_id: id.to_owned(),
            });
            channel_open = false;
            break;
        }
        if send(ProofEvent::Chunk {
            run_id: id.to_owned(),
            bytes: with_response_id(bytes, id),
        })
        .is_err()
        {
            channel_open = false;
            break;
        }
        if abort_after_first {
            for _ in 0..20 {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            terminal = Some(ProofEvent::Aborted {
                run_id: id.to_owned(),
            });
            channel_open = false;
            break;
        }
        if index + 1 < chunks.len() {
            thread::sleep(Duration::from_millis(5));
        }
    }

    if channel_open {
        terminal = Some(if fail {
            ProofEvent::Failed {
                run_id: id.to_owned(),
                message: "fixture stream failed",
            }
        } else {
            ProofEvent::Complete {
                run_id: id.to_owned(),
            }
        });
    }
    state.remove(id, stopped);
    if let Some(terminal) = terminal {
        let _ = send(terminal);
    }
}

fn with_response_id(template: &[u8], run_id: &str) -> Vec<u8> {
    const MARKER: &[u8] = b"\"id\":\"proof\"";
    let Some(start) = template
        .windows(MARKER.len())
        .position(|window| window == MARKER)
    else {
        return template.to_vec();
    };
    let id_start = start + b"\"id\":\"".len();
    let mut chunk = Vec::with_capacity(template.len() + run_id.len());
    chunk.extend_from_slice(&template[..id_start]);
    chunk.extend_from_slice(run_id.as_bytes());
    chunk.extend_from_slice(&template[id_start + b"proof".len()..]);
    chunk
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_RUN_ID
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        state: &ProofState,
        id: &str,
        scenario: ProofScenario,
        cancel: bool,
        fail_send: bool,
    ) -> Vec<ProofEvent> {
        let stopped = Arc::new(AtomicBool::new(cancel));
        state.insert(id, stopped.clone()).unwrap();
        if cancel {
            assert!(state.cancel(id).unwrap());
        }
        let mut events = Vec::new();
        produce(state, id, &stopped, scenario, &mut |event| {
            if fail_send {
                Err(())
            } else {
                events.push(event);
                Ok(())
            }
        });
        events
    }

    #[test]
    fn scripts_preserve_split_utf8_and_sse_boundaries() {
        let state = ProofState::default();
        let events = run(&state, "normal-1", ProofScenario::Normal, false, false);
        let chunks: Vec<Vec<u8>> = events
            .into_iter()
            .filter_map(|event| match event {
                ProofEvent::Chunk { bytes, .. } => Some(bytes),
                _ => None,
            })
            .collect();
        assert!(chunks[0].ends_with(b"caf\xc3"));
        assert!(chunks[1].starts_with(b"\xa9"));
        assert!(chunks
            .concat()
            .windows(5)
            .any(|window| window == b"caf\xc3\xa9"));
        assert_eq!(state.runs.lock().unwrap().len(), 0);
    }

    #[test]
    fn tool_call_script_emits_two_typed_actions_then_finishes() {
        let state = ProofState::default();
        let events = run(&state, "tools", ProofScenario::ToolCalls, false, false);
        let bytes = events
            .iter()
            .filter_map(|event| match event {
                ProofEvent::Chunk { bytes, .. } => Some(bytes.as_slice()),
                _ => None,
            })
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let script = String::from_utf8(bytes).unwrap();
        assert!(script.contains("\\\"action\\\":\\\"first\\\""));
        assert!(script.contains("\\\"action\\\":\\\"second\\\""));
        assert!(script.contains("\"finish_reason\":\"tool_calls\""));
        assert!(script.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn response_ids_are_unique_per_run_without_changing_split_utf8() {
        let state = ProofState::default();
        let first = run(&state, "turn-first", ProofScenario::ToolCalls, false, false);
        let second = run(&state, "turn-second", ProofScenario::Normal, false, false);
        let first_bytes: Vec<u8> = first
            .into_iter()
            .filter_map(|event| match event {
                ProofEvent::Chunk { bytes, .. } => Some(bytes),
                _ => None,
            })
            .flatten()
            .collect();
        let second_bytes: Vec<u8> = second
            .into_iter()
            .filter_map(|event| match event {
                ProofEvent::Chunk { bytes, .. } => Some(bytes),
                _ => None,
            })
            .flatten()
            .collect();
        assert!(first_bytes
            .windows(b"\"id\":\"turn-first\"".len())
            .any(|window| window == b"\"id\":\"turn-first\""));
        assert!(second_bytes
            .windows(b"\"id\":\"turn-second\"".len())
            .any(|window| window == b"\"id\":\"turn-second\""));
        assert!(second_bytes
            .windows(5)
            .any(|window| window == b"caf\xc3\xa9"));
    }

    #[test]
    fn channel_event_fields_match_the_renderer_camel_case_contract() {
        let events = [
            ProofEvent::Chunk {
                run_id: "run-1".into(),
                bytes: vec![1],
            },
            ProofEvent::Complete {
                run_id: "run-1".into(),
            },
            ProofEvent::Failed {
                run_id: "run-1".into(),
                message: "failed",
            },
            ProofEvent::Aborted {
                run_id: "run-1".into(),
            },
        ];
        for event in events {
            let value = serde_json::to_value(event).unwrap();
            assert_eq!(value["data"]["runId"], "run-1");
            assert!(value["data"].get("run_id").is_none());
        }
    }

    #[test]
    fn rejects_duplicate_and_bounded_inputs() {
        assert!(valid_run_id("run_01-test"));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id("../path"));
        assert!(!valid_run_id(&"x".repeat(MAX_RUN_ID + 1)));
        let state = ProofState::default();
        state
            .insert("same", Arc::new(AtomicBool::new(false)))
            .unwrap();
        assert_eq!(
            state.insert("same", Arc::new(AtomicBool::new(false))),
            Err("duplicate run id")
        );
        for index in 0..MAX_RUNS - 1 {
            state
                .insert(&format!("run-{index}"), Arc::new(AtomicBool::new(false)))
                .unwrap();
        }
        assert_eq!(
            state.insert("overflow", Arc::new(AtomicBool::new(false))),
            Err("too many active proof runs")
        );
    }

    #[test]
    fn abort_error_and_channel_failure_all_release_producer_state() {
        let state = ProofState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        state.insert("abort", stopped.clone()).unwrap();
        let mut aborted = Vec::new();
        produce(
            &state,
            "abort",
            &stopped,
            ProofScenario::Abort,
            &mut |event| {
                let first_chunk = matches!(event, ProofEvent::Chunk { .. });
                aborted.push(event);
                if first_chunk {
                    assert!(state.cancel("abort").unwrap());
                }
                Ok(())
            },
        );
        assert!(matches!(aborted.last(), Some(ProofEvent::Aborted { .. })));
        let failed = run(&state, "error", ProofScenario::Error, false, false);
        assert!(matches!(failed.last(), Some(ProofEvent::Failed { .. })));
        assert!(run(&state, "channel", ProofScenario::Normal, false, true).is_empty());
        assert!(state.runs.lock().unwrap().is_empty());
    }

    #[test]
    fn fixture_actions_have_only_fixed_results() {
        assert_eq!(proof_fixture_action(FixtureAction::First), "fixture:first");
        assert_eq!(
            proof_fixture_action(FixtureAction::Second),
            "fixture:second"
        );
    }
}
