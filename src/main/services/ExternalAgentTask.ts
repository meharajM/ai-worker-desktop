import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { capabilities, type LocalTaskModel, type TaskGrant, type TaskMode, type TaskView, type ServiceTool } from '../../shared/external-task'
import { hasControlCharacters } from '../../shared/control-characters'
import { ExternalWorkspace } from './ExternalWorkspace'
import { researchUrl } from './ExternalResearch'

type Service = { tool: ServiceTool; call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> }
interface Runtime {
  mode(): TaskMode
  readyLocalModel(): LocalTaskModel | null
  publish(view: TaskView | null): void
  services: Service[]
  privateDirs: string[]
  research(url: string, signal: AbortSignal): Promise<{ url: string; text: string; links: { text: string; url: string }[] }>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid action object.')
  return value as Record<string, unknown>
}

function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error('Invalid text argument.')
  return value
}

// The service catalog has already checked the supported resource names. Match
// the entire operation here so a composite such as get_or_create_task still waits.
function selectedServiceRead(name: string, args: Record<string, unknown>): boolean {
  const operation = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[-.]/g, '_')
    .replace(/^(?:github|gitlab|jira|notion|linear|asana|google|salesforce|hubspot)_/, '')
  if (['action', 'operation', 'method'].some(key => Object.hasOwn(args, key))) return false
  return operation === 'issue_read' || operation === 'pull_request_read' ||
    /^(?:get|read|list|lookup|find|search)_(?:(?:calendar|project|issue|document|spreadsheet|database|crm|pull|file)_)?[a-z]+$/.test(operation)
}

const line = (max: number) => z.string().min(1).max(max).trim().min(1).refine(value => !hasControlCharacters(value))
const note = (max: number) => z.string().min(1).max(max).trim().min(1)
  .refine(value => !hasControlCharacters(value, { allowLineWhitespace: true }))
const relativeFile = line(256).transform(file => file.replace(/\\/g, '/')).refine(file =>
  !file.includes(':') && file.split('/').every(part => part !== '' && part !== '.' && part !== '..'))

const taskRequest = z.strictObject({
  prompt: z.string().max(8000).trim().min(1),
  capabilities: z.array(z.enum(capabilities)).max(3).optional(),
  workspaceRoot: line(1024).optional(),
  handoffContext: z.strictObject({
    summary: note(2000).optional(),
    constraints: z.array(note(256)).max(8).optional(),
    relevantFiles: z.array(relativeFile).max(12).optional(),
    sourceAgent: line(96).optional(),
    workingDirectory: line(1024).refine(dir => posix.isAbsolute(dir) || win32.isAbsolute(dir)).optional(),
  }).optional(),
})

export function parseTask(body: Record<string, unknown>) {
  const { prompt, capabilities, workspaceRoot, handoffContext } = taskRequest.parse(body)
  return { prompt, requested: [...new Set(capabilities ?? [])], workspaceRoot, handoffContext }
}

export class ExternalAgentTask {
  readonly id = randomUUID()
  readonly controller = new AbortController()
  view: TaskView
  private pickedWorkspace: ExternalWorkspace | null = null
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void }
  private readonly runtime: Runtime

  constructor(input: ReturnType<typeof parseTask>, runtime: Runtime, ttl = 300_000) {
    this.runtime = runtime
    const { prompt, requested, workspaceRoot, handoffContext } = input
    // An inaccessible or foreign-host hint leaves the native folder picker available.
    if (requested.includes('workspace') && workspaceRoot && !/^[/\\]{2}/.test(workspaceRoot)) {
      try { this.pickedWorkspace = new ExternalWorkspace(workspaceRoot, runtime.privateDirs) } catch { /* no proposal */ }
    }
    this.view = { id: this.id, step: '', phase: 'working', prompt, requested, mode: runtime.mode(),
      workspaceRoot: this.pickedWorkspace?.root ?? null, handoffContext,
      expiresAt: Date.now() + ttl, services: requested.includes('services') && runtime.mode() === 'connected'
        ? runtime.services.map(s => s.tool) : [], title: '', detail: '' }
  }

  cancel(reason = 'Task cancelled.') {
    if (this.controller.signal.aborted) return
    const error = new Error(reason)
    this.controller.abort(error)
    this.pending?.reject(error)
    this.pending = undefined
  }

  private check() {
    if (Date.now() >= this.view.expiresAt) this.cancel('Task expired.')
    if (this.view.mode !== this.runtime.mode()) this.cancel('Privacy mode changed.')
    this.controller.signal.throwIfAborted()
  }

  selectWorkspace(step: string, selected: string) {
    this.check()
    if (this.view.step !== step || this.view.phase !== 'consent' || !this.view.requested.includes('workspace')) {
      throw new Error('Workspace selection expired.')
    }
    this.pickedWorkspace = new ExternalWorkspace(selected, this.runtime.privateDirs)
    return this.pickedWorkspace.root
  }

  reply(step: string, value: unknown, modelReply = false) {
    this.check()
    if (!this.pending || this.view.step !== step || (this.view.phase === 'planning') !== modelReply) return false
    const waiting = this.pending
    this.pending = undefined
    if (this.view.phase === 'consent' && value === 'model-unavailable') this.cancel('On-device planner unavailable. Choose an installed local model in Settings and retry.')
    if (value === false) this.cancel('Request declined in AI-Worker.')
    if (this.controller.signal.aborted) waiting.reject(this.controller.signal.reason)
    else waiting.resolve(value)
    return true
  }

  private display(phase: TaskView['phase'], title: string, detail = '') {
    this.check()
    this.view = { ...this.view, step: randomUUID(), phase, title, detail }
    this.runtime.publish(this.view)
  }

  private async wait(phase: TaskView['phase'], title: string, detail = '') {
    this.check()
    const result = new Promise<unknown>((resolve, reject) => { this.pending = { resolve, reject } })
    this.display(phase, title, detail)
    const value = await result
    this.check()
    return value
  }

  private async approve(phase: 'action' | 'file' | 'release', title: string, detail: string) {
    if (await this.wait(phase, title, detail) !== true) throw new Error('Explicit approval required.')
    this.display('working', title)
  }

  async run() {
    const deadline = setTimeout(() => this.cancel('Task expired.'), Math.max(0, this.view.expiresAt - Date.now()))
    let stop!: () => void
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(this.controller.signal.reason)
      this.controller.signal.addEventListener('abort', stop, { once: true })
    })
    try { return await Promise.race([stopped, this.loop()]) }
    finally {
      clearTimeout(deadline)
      this.controller.signal.removeEventListener('abort', stop)
      this.cancel()
      this.runtime.publish(null)
    }
  }

  private async loop(): Promise<{ content: string; sources: string[] }> {
    this.check()
    const { requested, mode } = this.view
    let grant: TaskGrant
    const localReadScope = mode === 'local-only' && requested.every(capability => capability === 'workspace') &&
      (!requested.includes('workspace') || this.pickedWorkspace !== null)
    if (localReadScope) {
      const model = this.runtime.readyLocalModel()
      if (!model) throw new Error('On-device planner unavailable. Choose an installed local model in Settings and retry.')
      grant = { workspace: this.pickedWorkspace?.root ?? null, web: false, services: [], model }
    } else {
      grant = record(await this.wait('consent', 'External agent request')) as unknown as TaskGrant
    }
    if (!grant.model || !['browser', 'ollama'].includes(grant.model.provider) ||
        !string(grant.model.model, 256) || !Array.isArray(grant.services) || grant.services.length > 8 ||
        !grant.services.every(i => Number.isInteger(i) && !!this.view.services[i]) ||
        typeof grant.web !== 'boolean' || (grant.web && !requested.includes('web')) ||
        ((grant.web || grant.services.length) && mode !== 'connected') ||
        (grant.workspace !== null && (!requested.includes('workspace') || typeof grant.workspace !== 'string'))) {
      throw new Error('Invalid task scope.')
    }
    if (grant.workspace !== null && grant.workspace !== this.pickedWorkspace?.root) throw new Error('Select the workspace in AI-Worker.')
    const workspace = grant.workspace ? this.pickedWorkspace : null
    this.view = { ...this.view, model: grant.model, workspaceRoot: workspace?.root ?? null }
    const tools: Record<string, unknown> = { answer: { text: 'final response' } }
    if (workspace) Object.assign(tools, {
      list: { path: 'relative directory, or .' }, read: { path: 'relative file' },
      search: { path: 'relative directory, or .', query: 'text or file name' },
      write: { path: 'relative file', content: 'complete proposed file text' },
    })
    if (grant.web) Object.assign(tools, { web_search: { query: 'search terms' }, web_read: { url: 'public HTTPS URL' } })
    const selected = new Map(grant.services.map(i => [`service_${i}`, this.runtime.services[i]]))
    for (const [key, service] of selected) tools[key] = service.tool
    const history: { action: unknown; observation: string }[] = []
    const sources = new Set<string>()
    for (let turn = 0; turn < 8; turn++) {
      const instruction = JSON.stringify({ task: this.view.prompt, workspaceRoot: this.view.workspaceRoot,
        handoffContext: this.view.handoffContext, actions: tools, history })
      const response = record(await this.wait('planning', 'Planning on device', instruction))
      if (response.error) throw new Error('On-device planner unavailable. Check the loaded model or loopback Ollama settings.')
      const content = string(response.content, 16_000).trim()
      let choice: Record<string, unknown>
      try { choice = record(JSON.parse(content.replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''))) }
      catch { throw new Error('On-device planner returned an invalid action. Retry with a model that supports JSON.') }
      const action = string(choice.action, 64)
      if (!Object.hasOwn(tools, action)) throw new Error('Planner requested an action outside the approved scope.')
      const args = record(choice.args)
      // The final response is also a disclosure. Review the exact payload returned to the host.
      if (action === 'answer') {
        const result = { content: string(args.text, 12_000), sources: [...sources] }
        await this.approve('release', 'Return this result to the MCP host?', JSON.stringify(result, null, 2))
        this.check()
        return result
      }
      let observation: string
      if (action === 'write' && workspace) {
        const path = string(args.path, 512)
        const content = string(args.content, 12_000, true)
        await this.approve('action', 'Stage workspace write', JSON.stringify({ workspace: workspace.root, path, content }, null, 2))
        const proposal = workspace.stage(path, content)
        await this.approve('file', 'Apply staged workspace write?', JSON.stringify({
          file: proposal.file, previous: proposal.before, proposed: proposal.content,
        }, null, 2))
        this.check()
        proposal.commit()
        observation = 'Approved file write completed.'
      } else if (workspace && ['read', 'list', 'search'].includes(action)) {
        const path = string(args.path, 512)
        const query = action === 'search' ? string(args.query, 256) : undefined
        this.check()
        observation = action === 'read' ? workspace.read(path) : JSON.stringify(workspace.search(path, query))
      } else if (grant.web && (action === 'web_read' || action === 'web_search')) {
        const url = action === 'web_read' ? researchUrl(string(args.url, 2048)).href :
          'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(string(args.query, 256))
        this.display('working', 'Reading a public page', url)
        this.check()
        const page = await this.runtime.research(url, this.controller.signal)
        this.check()
        sources.add(page.url)
        observation = JSON.stringify(page)
      } else {
        const service = selected.get(action)
        if (!service) throw new Error('Service outside the approved scope.')
        const { serverId, name } = service.tool
        const detail = JSON.stringify({ serverId, tool: name, arguments: args }, null, 2)
        if (selectedServiceRead(name, args)) this.display('working', 'Reading from selected service', detail)
        else await this.approve('action', 'Call selected connected service?', detail)
        this.check()
        observation = await service.call(args, this.controller.signal)
      }
      this.check()
      history.push({ action: { action, args }, observation: observation.slice(0, 8000) })
      if (JSON.stringify(history).length > 32_000) throw new Error('Task context limit reached.')
    }
    throw new Error('Task step limit reached.')
  }
}
