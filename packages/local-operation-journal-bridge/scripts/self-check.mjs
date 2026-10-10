import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJournalClient } from '../dist/index.js';

const manifest = fileURLToPath(new URL('../../../crates/local-operation-journal/Cargo.toml', import.meta.url));
const fixtures = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--manifest-path', manifest,
  '--features', 'bundled', '--example', 'recovery', '--', '--fixtures'], { encoding: 'utf8' }));
let cursor = 0;
const client = createJournalClient(async requestJson => {
  const fixture = fixtures[cursor++];
  assert.deepEqual(JSON.parse(requestJson), fixture.request);
  return JSON.stringify(fixture.response);
});
const task = { id: 'task-1', title: 'Reviewed demo' };
const intent = { id: 'bridge-proposal', task_id: 'task-1', kind: 'demo-effect',
  payload: { target: 'example.md', base_hash: 'old', proposed_hash: 'new' } };
assert.deepEqual((await client.createTask(task)).task, task);
assert.deepEqual((await client.getTask('task-1')).task, task);
assert.equal(await client.getTask('absent'), null);
assert.equal((await client.listTasks()).length, 1);
assert.equal((await client.propose(intent)).state, 'pending');
assert.equal((await client.getOperation('crashed')).state, 'succeeded');
assert.equal(await client.getOperation('absent'), null);
const operations = await client.listOperations('task-1');
assert(operations.some(v => v.state === 'uncertain'));
assert(operations.some(v => v.state === 'failed'));
assert(operations.some(v => v.state === 'cancelled'));
assert.deepEqual((await client.listEvents('crashed')).map(v => v.state),
  ['pending', 'approved', 'running', 'uncertain', 'succeeded']);
assert.equal(cursor, fixtures.length);
assert.equal('approve' in client, false);
assert.equal('begin' in client, false);
assert.equal('recoverRun' in client, false);
let calls = 0;
const rejectBeforeTransport = createJournalClient(async () => { calls++; throw new Error('should not call'); });
await assert.rejects(rejectBeforeTransport.propose({ ...intent, payload: Number.NaN }));
await assert.rejects(rejectBeforeTransport.propose({ ...intent, payload: 9_007_199_254_740_992 }));
await assert.rejects(rejectBeforeTransport.propose({ ...intent, payload: 'x'.repeat(80_000) }));
const circular = {}; circular.self = circular;
await assert.rejects(rejectBeforeTransport.propose({ ...intent, payload: circular }));
assert.equal(calls, 0);
for (const response of [
  '{invalid',
  JSON.stringify({ version: 2, result: { type: 'task', value: null } }),
  JSON.stringify({ version: 1, result: { type: 'operation', value: null } }),
  JSON.stringify({ version: 1, result: { type: 'task', value: { task, created_ms: 'bad' } } }),
  JSON.stringify({ version: 1, result: { type: 'task', value: null }, extra: true }),
]) {
  await assert.rejects(createJournalClient(async () => response).getTask('task-1'));
}
await assert.rejects(createJournalClient(async () => JSON.stringify({ version: 1, result: { type: 'task', value: null } })).createTask(task));
await assert.rejects(createJournalClient(async () => { throw new Error('native failure'); }).getTask('task-1'), /native failure/);
console.log('Rust/TypeScript contract and bridge self-check passed');
