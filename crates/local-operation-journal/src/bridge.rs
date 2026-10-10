//! Versioned JSON surface for untrusted UI clients. Approval/execution/recovery
//! methods are intentionally absent. Hosts must still scope task visibility and
//! validate proposal semantics; database identity is never chosen by a request.
use crate::{Error, Event, Intent, Journal, NewTask, Operation, Page, Result, Task};
use serde::{Deserialize, Serialize};

/// Current wire contract, checked before any request mutation.
pub const VERSION: u8 = 1;

/// Bounded protocol request; missing/unknown fields are rejected.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub command: Command,
}

/// Proposal submission and reads only. Do not add native authority methods here.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    CreateTask { task: NewTask },
    GetTask { id: String },
    ListTasks { page: Page },
    Propose { intent: Intent },
    GetOperation { id: String },
    ListOperations { task_id: String, page: Page },
    ListEvents { operation_id: String, page: Page },
}

/// Successful response. Host transports reject library errors separately.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub version: u8,
    pub result: Data,
}

/// Explicit result discriminant prevents response-type confusion.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Data {
    Task(Option<Task>),
    Tasks(Vec<Task>),
    Operation(Option<Operation>),
    Operations(Vec<Operation>),
    Events(Vec<Event>),
}

/// Dispatches a parsed request into the host-owned journal. The host authorizes
/// its sender/task scope before calling this; no filesystem/CLI actions occur.
/// Errors leave prior committed state intact. Never expose raw SQL through IPC.
pub fn dispatch(journal: &mut Journal, request: Request) -> Result<Response> {
    if request.version != VERSION {
        return Err(Error::InvalidInput("unsupported bridge version"));
    }
    let result = match request.command {
        Command::CreateTask { task } => Data::Task(Some(journal.create_task(task)?)),
        Command::GetTask { id } => Data::Task(journal.task(&id)?),
        Command::ListTasks { page } => Data::Tasks(journal.tasks(page)?),
        Command::Propose { intent } => Data::Operation(Some(journal.propose(intent)?)),
        Command::GetOperation { id } => Data::Operation(journal.operation(&id)?),
        Command::ListOperations { task_id, page } => {
            Data::Operations(journal.operations(&task_id, page)?)
        }
        Command::ListEvents { operation_id, page } => {
            Data::Events(journal.events(&operation_id, page)?)
        }
    };
    Ok(Response {
        version: VERSION,
        result,
    })
}

/// Parses at most 70 KiB of UTF-8 JSON before dispatch. Use this entry point at
/// transport boundaries after authenticating/scoping the sender. Reject errors
/// through the transport; do not return a success-shaped string for failures.
pub fn dispatch_json(journal: &mut Journal, request: &str) -> Result<String> {
    if request.len() > 71_680 {
        return Err(Error::InvalidInput("bridge request exceeds 70 KiB"));
    }
    Ok(serde_json::to_string(&dispatch(
        journal,
        serde_json::from_str(request)?,
    )?)?)
}
