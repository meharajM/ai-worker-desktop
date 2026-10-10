//! Assert-based smoke check using a private temporary database, never user data.
//! Pass --fixtures to print real Rust wire responses for the TypeScript check.
use local_operation_journal::{
    bridge::{self, Command, Request},
    *,
};
use serde_json::{Value, json};
use std::{
    error::Error as StdError,
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> std::io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("local-journal-{}-{nonce}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn intent(id: &str) -> Intent {
    Intent {
        id: id.into(),
        task_id: "task-1".into(),
        kind: "demo-effect".into(),
        payload: json!({"target": "example.md", "base_hash": "old", "proposed_hash": "new"}),
    }
}

fn main() -> std::result::Result<(), Box<dyn StdError>> {
    let dir = TempDir::new()?;
    let path = dir.0.join("journal.sqlite");
    let mut journal = Journal::open(&path)?;
    let task = NewTask {
        id: "task-1".into(),
        title: "Reviewed demo".into(),
    };
    let created = journal.create_task(task.clone())?;
    assert_eq!(journal.create_task(task.clone())?, created);
    assert!(matches!(
        journal.create_task(NewTask {
            title: "different".into(),
            ..task.clone()
        }),
        Err(Error::Conflict)
    ));
    let proposed = journal.propose(intent("crashed"))?;
    assert_eq!(journal.propose(intent("crashed"))?, proposed);
    assert!(matches!(
        journal.propose(Intent {
            payload: json!({"changed": true}),
            ..intent("crashed")
        }),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        journal.begin("crashed", "dead-run"),
        Err(Error::InvalidState(State::Pending))
    ));
    let approved = journal.approve("crashed", "dead-run", Duration::from_secs(60))?;
    assert_eq!(
        journal.approve("crashed", "dead-run", Duration::from_secs(3600))?,
        approved
    );
    assert!(matches!(
        journal.begin("crashed", "other-run"),
        Err(Error::WrongRun)
    ));
    journal.begin("crashed", "dead-run")?;
    assert!(matches!(
        journal.begin("crashed", "dead-run"),
        Err(Error::InvalidState(State::Running))
    ));
    assert!(matches!(
        journal.cancel("crashed"),
        Err(Error::InvalidState(State::Running))
    ));
    journal.propose(intent("unused"))?;
    journal.approve("unused", "dead-run", Duration::from_secs(60))?;
    journal.propose(intent("live"))?;
    journal.approve("live", "live-run", Duration::from_secs(60))?;
    journal.begin("live", "live-run")?;
    drop(journal);

    let mut journal = Journal::open(&path)?;
    assert_eq!(journal.operation("crashed")?.unwrap().state, State::Running);
    assert_eq!(
        journal.recover_run("dead-run")?,
        Recovery {
            invalidated_approvals: 1,
            uncertain_operations: 1
        }
    );
    assert_eq!(
        journal.recover_run("dead-run")?,
        Recovery {
            invalidated_approvals: 0,
            uncertain_operations: 0
        }
    );
    assert_eq!(journal.operation("unused")?.unwrap().state, State::Pending);
    assert_eq!(journal.operation("live")?.unwrap().state, State::Running);
    assert!(matches!(
        journal.begin("crashed", "dead-run"),
        Err(Error::InvalidState(State::Uncertain))
    ));
    assert_eq!(
        journal
            .events("crashed", Page::default())?
            .iter()
            .map(|e| e.state)
            .collect::<Vec<_>>(),
        vec![
            State::Pending,
            State::Approved,
            State::Running,
            State::Uncertain
        ]
    );
    journal.resolve(
        "crashed",
        Outcome::Succeeded(json!({"verified_hash": "new"})),
    )?;
    assert_eq!(journal.propose(intent("crashed"))?.state, State::Succeeded);
    journal.finish("live", "live-run", Outcome::Failed(json!({"exit_code": 1})))?;
    journal.propose(intent("unknown"))?;
    journal.approve("unknown", "live-run", Duration::from_secs(60))?;
    journal.begin("unknown", "live-run")?;
    journal.mark_uncertain("unknown", "live-run")?;
    journal.propose(intent("cancelled"))?;
    journal.cancel("cancelled")?;

    journal.propose(intent("expired"))?;
    journal.approve("expired", "live-run", Duration::from_secs(60))?;
    // Simulate elapsed wall time deterministically instead of sleeping.
    let raw = rusqlite::Connection::open(&path)?;
    raw.execute(
        "UPDATE operations SET approval_expires_ms=0 WHERE id='expired'",
        [],
    )?;
    assert!(matches!(
        journal.begin("expired", "live-run"),
        Err(Error::ApprovalExpired)
    ));
    journal.revoke("expired")?;
    assert!(matches!(
        journal.approve("expired", "live-run", Duration::ZERO),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        journal.operations(
            "task-1",
            Page {
                limit: 101,
                offset: 0
            }
        ),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        journal.propose(Intent {
            payload: json!("x".repeat(65_537)),
            ..intent("large")
        }),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        journal.propose(Intent {
            payload: json!(9_007_199_254_740_992_u64),
            ..intent("unsafe-integer")
        }),
        Err(Error::InvalidInput(_))
    ));
    assert!(journal.operation("large")?.is_none());
    assert!(journal.operation("unsafe-integer")?.is_none());

    // A failed event insert must roll back the operation update in the same transaction.
    journal.propose(intent("rollback"))?;
    journal.approve("rollback", "live-run", Duration::from_secs(60))?;
    journal.begin("rollback", "live-run")?;
    raw.execute_batch(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON events
        WHEN NEW.operation_id='rollback' AND NEW.state='succeeded'
        BEGIN SELECT RAISE(ABORT, 'simulated event failure'); END;",
    )?;
    assert!(matches!(
        journal.finish(
            "rollback",
            "live-run",
            Outcome::Succeeded(json!({"effect": "verified"}))
        ),
        Err(Error::Database(_))
    ));
    assert_eq!(
        journal.operation("rollback")?.unwrap().state,
        State::Running
    );
    assert!(journal.operation("rollback")?.unwrap().outcome.is_none());
    assert_eq!(journal.events("rollback", Page::default())?.len(), 3);
    raw.execute_batch("DROP TRIGGER reject_receipt")?;
    journal.mark_uncertain("rollback", "live-run")?;

    #[cfg(unix)]
    {
        let alias = dir.0.join("symlink.sqlite");
        std::os::unix::fs::symlink(&path, &alias)?;
        assert!(matches!(Journal::open(alias), Err(Error::Database(_))));
    }

    // Two independent connections may not consume the same approval twice.
    journal.propose(intent("race"))?;
    journal.approve("race", "race-run", Duration::from_secs(60))?;
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(path).unwrap();
                barrier.wait();
                journal.begin("race", "race-run")
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::InvalidState(State::Running))))
            .count(),
        1
    );
    journal.recover_run("race-run")?;

    // Reject authority commands, forged fields and protocol versions before mutations.
    assert!(
        bridge::dispatch_json(
            &mut journal,
            r#"{"version":1,"command":{"method":"approve","id":"expired"}}"#
        )
        .is_err()
    );
    assert!(
        bridge::dispatch_json(
            &mut journal,
            r#"{"version":1,"command":{"method":"get_task","id":"task-1","auto_approve":true}}"#
        )
        .is_err()
    );
    assert!(
        bridge::dispatch_json(
            &mut journal,
            r#"{"version":2,"command":{"method":"get_task","id":"task-1"}}"#
        )
        .is_err()
    );
    assert!(bridge::dispatch_json(&mut journal, &" ".repeat(71_681)).is_err());
    assert!(bridge::dispatch_json(&mut journal, r#"{"version":2,"command":{"method":"create_task","task":{"id":"wrong-version","title":"must not exist"}}}"#).is_err());
    assert!(journal.task("wrong-version")?.is_none());
    let foreign = dir.0.join("foreign.sqlite");
    rusqlite::Connection::open(&foreign)?.execute("CREATE TABLE unrelated (id INTEGER)", [])?;
    assert!(matches!(
        Journal::open(&foreign),
        Err(Error::IncompatibleDatabase)
    ));
    let newer = dir.0.join("newer.sqlite");
    drop(Journal::open(&newer)?);
    let newer_conn = rusqlite::Connection::open(&newer)?;
    newer_conn.pragma_update(None, "user_version", 2)?;
    assert!(matches!(
        Journal::open(&newer),
        Err(Error::IncompatibleDatabase)
    ));

    let commands = vec![
        Command::CreateTask { task },
        Command::GetTask {
            id: "task-1".into(),
        },
        Command::GetTask {
            id: "absent".into(),
        },
        Command::ListTasks {
            page: Page::default(),
        },
        Command::Propose {
            intent: intent("bridge-proposal"),
        },
        Command::GetOperation {
            id: "crashed".into(),
        },
        Command::GetOperation {
            id: "absent".into(),
        },
        Command::ListOperations {
            task_id: "task-1".into(),
            page: Page::default(),
        },
        Command::ListEvents {
            operation_id: "crashed".into(),
            page: Page::default(),
        },
    ];
    let mut fixtures = Vec::<Value>::new();
    for command in commands {
        let request = Request {
            version: bridge::VERSION,
            command,
        };
        let request = serde_json::to_value(request)?;
        let response = bridge::dispatch_json(&mut journal, &serde_json::to_string(&request)?)?;
        fixtures.push(
            json!({"request": request, "response": serde_json::from_str::<Value>(&response)?}),
        );
    }
    drop(raw);
    drop(newer_conn);
    drop(journal);
    if std::env::args().any(|v| v == "--fixtures") {
        println!("{}", serde_json::to_string(&fixtures)?);
    } else {
        println!("journal recovery self-check passed");
    }
    Ok(())
}
