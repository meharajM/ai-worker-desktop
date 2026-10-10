# local-operation-journal-bridge

MIT-licensed TypeScript client for the [Rust journal](../../crates/local-operation-journal/).
Provisional 0.1.0; not published to npm. No runtime dependencies. The package
contains ES modules and declarations, and needs a host-provided transport.

## Use in an offline Tauri UI

```ts
import { invoke } from '@tauri-apps/api/core'; // supplied by the Tauri host
import { createJournalClient } from 'local-operation-journal-bridge';

const journal = createJournalClient(request => invoke<string>('journal', { request }));
const task = await journal.createTask({ id: crypto.randomUUID(), title: 'Write report' });
const proposal = await journal.propose({
  id: crypto.randomUUID(), task_id: task.task.id, kind: 'file-write',
  payload: { target: 'report.md', base_hash: 'sha256:...', proposed_hash: 'sha256:...' },
});
// Display pending facts for review; no write occurs through this API.
const history = await journal.listEvents(proposal.intent.id);
```

This example assumes the host implements/authorizes the `journal` command and
validates that proposal schema. That application command is not part of this
package. The Rust `bridge::dispatch_json` function is its portable backend.
The same client can use another IPC implementation without importing Tauri:

```ts
const journal = createJournalClient(authenticatedHostTransport);
```

## Contract

- Methods: `createTask`, `getTask`, `listTasks`, `propose`, `getOperation`,
  `listOperations`, `listEvents`. Pagination defaults to 50, maximum 100 records.
- Wire version 1 uses snake_case DTO fields. Transport sends a JSON request string
  and resolves with a JSON response string. It must reject native errors; client
  propagates them without retrying mutations. Invalid responses also reject.
- Runtime validation checks version, result type, DTO fields, finite/safe numbers,
  nested JSON and response bounds. Requests are limited to 70 KiB; payloads and
  receipts are limited by Rust to 64 KiB. Encode large integers as strings.
- No approval, execution, arbitrary file access, SQL or recovery methods. UI/model
  input cannot turn a pending proposal into executable authority through this bridge.
- Sender authorization, database selection, supported kinds, task visibility and
  native approval handlers are host responsibilities. Run IDs and proposal IDs
  are identities, not credentials. Do not store secrets in payloads/receipts.
- `uncertain` means the host must reconcile the effect. Do not automatically submit
  a new proposal or execute again because a receipt is missing.

## Build and check

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

The check runs the Rust recovery example with bundled SQLite, uses its real JSON
fixtures to exercise every TS method, and rejects malformed/version-mismatched
responses, lossy requests and forged authority methods. Rust/Cargo and a C compiler
are development requirements only; consumers of the built JS need neither Node
nor a build tool at runtime. Package names/API remain provisional until release.
