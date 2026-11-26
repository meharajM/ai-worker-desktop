import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ServiceTool } from '../../shared/external-task'

// Reviewed operation names. A custom server is trusted only when the user
// selects its exact live connection and then approves the full arguments.
const forbidden = /(?:^|_)(?:exec(?:ute)?|run|shell|command|terminal|script|eval(?:uate)?|code_execution|browser|navigate|http|fetch|network|proxy|graphql|sql|process|filesystem|credential|secret|token|password|login|auth|connect|send|publish|invite|notify|messages?|emails?|comments?|recipients?|webhooks?)(?:_|$)/
const recordOperation = /(?:^|_)(?:get|read|list|lookup|find|search|create|add|insert|append|update|edit|set|move|archive|restore|delete|remove|complete|rename|copy|clear|batch_update)_(?:(?:calendar|project|issue|document|spreadsheet|database|crm)_)?(?:issues?|pull_requests?|commits?|repositories|repository|code|calendars?|events?|documents?|notes?|pages?|blocks?|spreadsheets?|sheets?|cells?|ranges?|rows?|columns?|values|projects?|tasks?|labels?|milestones?|records?|tables?|databases?|contacts?|companies|customers?|deals?|tickets?|drafts?)$/
const namedOperations = new Set(['issue_read', 'issue_write', 'pull_request_read'])
const dangerousField = /^(?:cmd|command|executable|script|code|url|uri|endpoint|baseurl|headers|authorization|apikey|token|password|secret|webhook|sendupdates|sendnotifications|attendees|recipient|recipients|invitees)$/i

function unsafeFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) =>
    dangerousField.test(key.replace(/[_-]/g, '')) || unsafeFields(nested))
}

function eligible(tool: Tool) {
  const name = tool.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[-.]/g, '_')
  if (forbidden.test(name)) return false
  if (tool.inputSchema.required?.some(key => dangerousField.test(key.replace(/[_-]/g, '')))) return false
  if (name === 'get_file_contents') {
    const props = tool.inputSchema.properties || {}
    return 'owner' in props && 'repo' in props
  }
  return namedOperations.has(name) || recordOperation.test(name)
}

const catalogs = new WeakMap<Client, ServiceTool[]>()

export function rememberExternalTools(serverId: string, client: Client, tools: Tool[]) {
  const offered: ServiceTool[] = []
  for (const tool of tools) {
    if (!eligible(tool) || tool.name.length > 128 || serverId.length > 256) continue
    // Keep schemas bounded and avoid passing defaults, examples or server-supplied
    // descriptions (which can contain account data) to the planner.
    const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties || {})
      .filter(([key]) => !dangerousField.test(key.replace(/[_-]/g, '')))
      .map(([key, schema]) => [key, { type: (schema as { type?: string })?.type || 'any' }]))
    const parameters = { type: 'object', properties, required: tool.inputSchema.required || [] }
    if (JSON.stringify(parameters).length > 3000) continue
    offered.push({ serverId, name: tool.name, parameters })
    if (offered.length >= 32) break
  }
  catalogs.set(client, offered)
}

export function externalServiceChoices(connections: Map<string, Client>) {
  return Array.from(connections.entries()).flatMap(([id, client]) =>
    (catalogs.get(client) || []).filter(tool => tool.serverId === id).map(tool => ({
      tool,
      async call(args: Record<string, unknown>, signal: AbortSignal) {
        signal.throwIfAborted()
        if (connections.get(id) !== client || !catalogs.get(client)?.some(current => current.name === tool.name &&
              JSON.stringify(current.parameters) === JSON.stringify(tool.parameters))) {
          throw new Error('Selected service connection changed. Start a new task.')
        }
        if (unsafeFields(args)) throw new Error('Arguments outside the delegated service scope.')
        const schema = tool.parameters as Tool['inputSchema']
        if (schema.properties && Object.keys(args).some(key => !Object.hasOwn(schema.properties!, key))) {
          throw new Error('Service argument was not advertised by the selected tool.')
        }
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 25_000 })
        signal.throwIfAborted()
        if (result.isError) throw new Error('Selected service reported a tool error.')
        const blocks = Array.isArray(result.content) ? result.content : []
        return blocks.filter(block => block?.type === 'text').slice(0, 8)
          .map(block => String(block.text).slice(0, 8000)).join('\n').slice(0, 8000)
      },
    }))).slice(0, 64)
}
