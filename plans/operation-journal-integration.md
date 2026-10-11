# Reusable operation journal: integration cards

User decision: Rust crate plus TypeScript bridge, provisionally named
`local-operation-journal`, reusable by other open-source applications.

## Implemented standalone boundary

- Rust: `crates/local-operation-journal`, provisional 0.1.0, MIT, rusqlite/serde/serde_json.
- TypeScript: `packages/local-operation-journal-bridge`, provisional 0.1.0, MIT, zero runtime dependencies.
- Immutable task/intent IDs, bounded records/pages, guarded state transitions,
  native-owned expiring approvals, single-use execution claims, transactional events.
- Explicit recovery scoped to a host-proven dead run; interrupted effects become
  uncertain and cannot replay. Unused dead-run approvals return to pending.
- Versioned JSON protocol exposes proposal submission/reads only. Hosts supply the
  transport, authentication, task scope and semantic validation.
- Assert-based recovery and real Rust/TypeScript wire-contract checks.

This does not complete M21–M27. No Electron service is replaced yet; the Tauri
scaffold has no journal host integration, registry publication or claim of Windows/whole-app verification.
Begin host integration at M21/J01. Do not add Temporal, a daemon, scheduler, ORM, MCP wrapper or
another storage backend for this integration.

### Local evidence, 10 October 2026

macOS checks used Rust 1.94.1, Node 24.7.0, TypeScript 5.9.3 and locked rusqlite
0.40.2 with bundled SQLite. Recovery/contract self-check and Clippy passed. The
Rust source package verification and npm package dry run passed. A focused CI
workflow is configured for macOS/Windows; its remote results are still pending.

The compiled bridge is 4,835 bytes of JS (1,754 bytes gzip), with no runtime
dependencies. This measures the bridge module only: it excludes declarations,
native SQLite/Rust linkage, Tauri/WebView and inference. Native/app footprint and
physical power-loss recovery have not been benchmarked. Failure injection covers
transaction rollback; process interruption is simulated by closing/reopening the
temporary journal, with no real filesystem/CLI effect.

## Luna cards

Dispatch sequentially; each card has one entry point and at most three production
files. Split a card again if caller integration exceeds that size. Read the crate
README contract before coding. Native policy remains independent of journal IDs.

### J01 — Own the journal inside the native host (start of M21)

**Depends:** M00–M05, M17 grants and M20 read-only workflows. J01 is the first packet of M21's effects phase, after chat and read-only work; it precedes J02 and proposal staging. M13 chat and M17–M20 read-only capability do not use the journal.

Entry: native journal host module, bridge registration and host dependency manifest.
Enable `bundled` deliberately; use a user-private app-data directory and one bounded
blocking worker. Acquire application singleton/run ownership, persist unique run
identity, and prove prior owners/processes dead before recovering them. Existing
chat/JSON data remains untouched. Surface DB failure without authorizing tools.

**Check:** macOS/Windows reopen, busy DB, incompatible schema, second live host,
owned process still live and disk/permission failure. No recovery guessed from age.

### J02 — Bind app proposals to immutable journal intents (within M21/M26)

**Depends:** J01, M17 file grants or M25 command catalog.

Entry: proposal schema/policy, proposal creation and UI journal adapter.
Validate exact scope, action, target/base/proposed hash or executable/argv/cwd/env;
prepare durable immutable staging/backup references before approval. Host authorizes
window/profile/task reads and each supported kind, then delegates bounded JSON to
the crate. TS transport uses the portable package; generic bridge cannot approve.

**Check:** modified ID contents, unknown kinds/fields, spoofed grant/task, stale
staging hash, arbitrary DB path/SQL/approval request, huge payload and sender closure.

### J03 — Couple review and effects to journal transitions (within M22/M26/M27)

**Depends:** J02 and file/CLI execution skeleton.

Entry: dedicated human review handler, guarded executor and outcome presentation.
Bind review to exact intent, enforce monotonic task deadlines and live grant
revocation, and commit begin before the external effect. Record verified receipts;
failure to record a receipt never retries the effect. Running cancellation first
stops/reconciles the effect; ambiguous outcome becomes uncertain. No model approval.

**Check:** double-click/concurrent begin, expired/wrong-run review, revoked grant,
interruption before/after effect and failed outcome commit. One external attempt.

### J04 — Reconcile interrupted effects and reviewed undo (within M23)

**Depends:** J03 and process ownership cleanup.

Entry: native startup recovery, file reconciliation and uncertain-result UI.
Recover only known dead runs after stopping owned processes. Compare current file
hash against base/proposed/backup facts; preserve user edits and missing/conflicting
evidence. CLI results remain uncertain unless verified; user decides any reviewed
retry with a new ID. Undo is a separate reviewed intent. Never delete idempotency
history while staging/backup cleanup runs.

**Check:** every crash boundary, repeated recovery, newer target, missing backup,
absent command receipt, already-completed ID and rejected retry. Original files survive.

### J05 — Prepare matching community releases

**Depends:** J04 and macOS/Windows evidence.

Entry: package manifests, READMEs and release notes.
Verify crates.io/npm names and package contents, review provisional API, document
system versus bundled SQLite costs and compatible wire version. Record footprint,
licenses, supported Rust/Node development versions and cross-platform checks.
Publishing is a separate explicit user action; do not publish from integration cards.

**Check:** clean locked package builds, both registry tarballs, matching 0.1.0
contract, consumer path/registry install example and no runtime framework dependency.
