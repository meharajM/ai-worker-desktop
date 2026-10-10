/**
 * Portable journal client: versioned requests, bounded JSON and checked responses.
 * The injected host transport owns IPC authorization and database selection.
 * This module exposes proposals and reads; native approval/execution stays private.
 * Consumed by offline web UIs or other TypeScript hosts; no runtime dependencies.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type State = 'pending' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export interface NewTask { id: string; title: string }
export interface Task { task: NewTask; created_ms: number }
export interface Intent { id: string; task_id: string; kind: string; payload: JsonValue }
export interface Operation {
  intent: Intent;
  state: State;
  run_id: string | null;
  approval_expires_ms: number | null;
  outcome: JsonValue;
  created_ms: number;
  updated_ms: number;
}
export interface Event { sequence: number; operation_id: string; state: State; at_ms: number }
export interface Page { limit: number; offset: number }

export type Command =
  | { method: 'create_task'; task: NewTask }
  | { method: 'get_task'; id: string }
  | { method: 'list_tasks'; page: Page }
  | { method: 'propose'; intent: Intent }
  | { method: 'get_operation'; id: string }
  | { method: 'list_operations'; task_id: string; page: Page }
  | { method: 'list_events'; operation_id: string; page: Page };
export interface Request { version: 1; command: Command }
export type Data =
  | { type: 'task'; value: Task | null }
  | { type: 'tasks'; value: Task[] }
  | { type: 'operation'; value: Operation | null }
  | { type: 'operations'; value: Operation[] }
  | { type: 'events'; value: Event[] };
export interface Response { version: 1; result: Data }

/** Reject on host/library errors. A returned string must be a Rust Response JSON. */
export type Transport = (requestJson: string) => Promise<string>;

/** Public UI API. It cannot approve, begin, finish, resolve or recover operations. */
export interface JournalClient {
  /** Submit immutable task metadata; same ID with different content rejects. */
  createTask(task: NewTask): Promise<Task>;
  /** Read a host-authorized task, or null. */
  getTask(id: string): Promise<Task | null>;
  /** Read a bounded live page, defaulting to 50 records. */
  listTasks(page?: Page): Promise<Task[]>;
  /** Submit immutable pending intent; never grants permission to execute. */
  propose(intent: Intent): Promise<Operation>;
  /** Read operation facts, or null; uncertain requires host reconciliation. */
  getOperation(id: string): Promise<Operation | null>;
  /** Read at most 100 operations from one authorized task. */
  listOperations(taskId: string, page?: Page): Promise<Operation[]>;
  /** Read at most 100 committed transitions for one authorized operation. */
  listEvents(operationId: string, page?: Page): Promise<Event[]>;
}

const encoder = new TextEncoder();
const states: readonly string[] = ['pending', 'approved', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const defaultPage: Page = { limit: 50, offset: 0 };
type Check<T> = (value: unknown) => value is T;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string';
const state = (v: unknown): v is State => text(v) && states.includes(v);
const keys = (v: Record<string, unknown>, fields: string[]): boolean =>
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));

function json(v: unknown, depth = 0, maxDepth = 64): v is JsonValue {
  if (depth > maxDepth) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
  if (Array.isArray(v)) return v.every(item => json(item, depth + 1, maxDepth));
  return record(v) && Object.values(v).every(item => json(item, depth + 1, maxDepth));
}

const task: Check<Task> = (v): v is Task => record(v) && keys(v, ['task', 'created_ms']) && integer(v.created_ms)
  && record(v.task) && keys(v.task, ['id', 'title']) && text(v.task.id) && text(v.task.title);
const intent: Check<Intent> = (v): v is Intent => record(v) && keys(v, ['id', 'task_id', 'kind', 'payload'])
  && text(v.id) && text(v.task_id) && text(v.kind) && json(v.payload);
const operation: Check<Operation> = (v): v is Operation => record(v)
  && keys(v, ['intent', 'state', 'run_id', 'approval_expires_ms', 'outcome', 'created_ms', 'updated_ms'])
  && intent(v.intent) && state(v.state) && (v.run_id === null || text(v.run_id))
  && (v.approval_expires_ms === null || integer(v.approval_expires_ms))
  && json(v.outcome) && integer(v.created_ms) && integer(v.updated_ms);
const event: Check<Event> = (v): v is Event => record(v) && keys(v, ['sequence', 'operation_id', 'state', 'at_ms'])
  && integer(v.sequence) && text(v.operation_id) && state(v.state) && integer(v.at_ms);
const nullable = <T>(check: Check<T>): Check<T | null> => (v): v is T | null => v === null || check(v);
const array = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => Array.isArray(v) && v.length <= 100 && v.every(check);

/**
 * Creates a client for a host-owned journal. Requests are limited to 70 KiB;
 * malformed, oversized, wrong-version or wrong-type responses reject.
 * @param transport Authenticated/scoped IPC function; rejects native errors.
 * @returns A client with proposal submission and read methods.
 * @throws Error for invalid responses/input; transport errors pass through.
 * @example
 * const client = createJournalClient(json => invoke<string>('journal', { request: json }));
 */
export function createJournalClient(transport: Transport): JournalClient {
  async function call<T>(command: Command, type: Data['type'], check: Check<T>): Promise<T> {
    // Rust remains the admission authority; reject lossy JS values before serialization.
    if (!json(command, 0, 66)) throw new Error('Request must contain finite, bounded JSON; encode large integers as strings');
    const request = JSON.stringify({ version: 1, command } satisfies Request);
    if (encoder.encode(request).byteLength > 71_680) throw new Error('Bridge request exceeds 70 KiB');
    const response = await transport(request);
    if (typeof response !== 'string' || encoder.encode(response).byteLength > 16_777_216) {
      throw new Error('Invalid or oversized journal response');
    }
    const parsed: unknown = JSON.parse(response);
    if (!record(parsed) || !keys(parsed, ['version', 'result']) || parsed.version !== 1
      || !record(parsed.result) || !keys(parsed.result, ['type', 'value'])
      || parsed.result.type !== type || !check(parsed.result.value)) {
      throw new Error('Invalid journal response or unsupported bridge version');
    }
    return parsed.result.value;
  }
  return {
    createTask: input => call({ method: 'create_task', task: input }, 'task', task),
    getTask: id => call({ method: 'get_task', id }, 'task', nullable(task)),
    listTasks: (page = defaultPage) => call({ method: 'list_tasks', page }, 'tasks', array(task)),
    propose: intent => call({ method: 'propose', intent }, 'operation', operation),
    getOperation: id => call({ method: 'get_operation', id }, 'operation', nullable(operation)),
    listOperations: (task_id, page = defaultPage) => call({ method: 'list_operations', task_id, page }, 'operations', array(operation)),
    listEvents: (operation_id, page = defaultPage) => call({ method: 'list_events', operation_id, page }, 'events', array(event)),
  };
}
