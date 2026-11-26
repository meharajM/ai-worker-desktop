import { ipcMain as electronIpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'

const trustedRenderers = new Map<WebContents, URL>()

function documentUrl(value: string): URL {
    const url = new URL(value)
    url.hash = ''
    url.search = ''
    return url
}

export function trustRenderer(contents: WebContents, entryUrl: string): void {
    trustedRenderers.set(contents, documentUrl(entryUrl))
    contents.once('destroyed', () => trustedRenderers.delete(contents))
}

export function isTrustedRendererUrl(contents: WebContents | null, value: string): boolean {
    if (!contents || contents.isDestroyed()) return false
    const expected = trustedRenderers.get(contents)
    if (!expected) return false
    try {
        return documentUrl(value).href === expected.href
    } catch {
        return false
    }
}

export function validateIpcSender(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !isTrustedRendererUrl(event.sender, frame.url)) return false
    const expected = trustedRenderers.get(event.sender)!
    // file: origins are opaque; require the registered window and exact entry file above.
    return expected.protocol === 'file:' || frame.origin === expected.origin
}

export const ipcMain = {
    handle(channel: string, listener: Parameters<typeof electronIpcMain.handle>[1]): void {
        electronIpcMain.handle(channel, (event, ...args) => {
            if (!validateIpcSender(event)) throw new Error('Untrusted IPC sender')
            return listener(event, ...args)
        })
    }
}

export function safeExternalUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid external URL')
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error('Only HTTP(S) browser links are allowed')
    }
    return url.href
}
