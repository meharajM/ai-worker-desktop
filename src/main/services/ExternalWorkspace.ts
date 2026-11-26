import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

const MAX_FILE_BYTES = 16_000
const DENIED = /^(?:\.|node_modules$|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|kdbx)$)/i

function safeName(name: string): boolean {
  return !!name && !DENIED.test(name) && !/[\\/:\x00-\x1f]/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && !/[. ]$/.test(name)
}

function inside(parent: string, file: string): boolean {
  const relative = path.relative(parent, file)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/** Paths are relative to the explicitly selected directory. Never follow links or read devices. */
export class ExternalWorkspace {
  readonly root: string
  private identity: fs.Stats

  constructor(selected: string, privateDirs: string[] = []) {
    if (!path.isAbsolute(selected)) throw new Error('Select a workspace directory.')
    this.root = fs.realpathSync(selected)
    const home = fs.realpathSync(homedir())
    if (this.root === home || this.root === path.parse(this.root).root ||
        this.root.split(path.sep).some(part => part.startsWith('.')) ||
        [...privateDirs, path.join(home, 'Library'), path.join(home, 'AppData')].some(dir => inside(dir, this.root))) {
      throw new Error('Select a project directory outside private application storage.')
    }
    this.identity = fs.statSync(this.root)
    if (!this.identity.isDirectory()) throw new Error('Select a directory.')
    this.privateDirs = privateDirs.map(dir => path.resolve(dir))
  }

  private readonly privateDirs: string[]

  private target(relative: string, allowMissing = false): string {
    const current = fs.lstatSync(this.root)
    if (!current.isDirectory() || fs.realpathSync(this.root) !== this.root ||
        current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new Error('Workspace changed.')
    if (relative === '.') return this.root
    const parts = relative.split('/')
    if (relative.length > 512 || parts.length > 16 || parts.some(part => !safeName(part))) throw new Error('Invalid workspace path.')
    let file = this.root
    for (const [i, part] of parts.entries()) {
      file = path.join(file, part)
      if (this.privateDirs.some(dir => inside(dir, file))) throw new Error('Private application directory.')
      const stat = fs.lstatSync(file, { throwIfNoEntry: false })
      if (!stat && allowMissing && i === parts.length - 1) break
      if (!stat || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error('Workspace path changed or contains a link.')
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Invalid workspace directory.')
    }
    return file
  }

  read(relative: string): string {
    const file = this.target(relative)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    try {
      const stat = fs.fstatSync(fd)
      const current = fs.lstatSync(this.target(relative))
      if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) {
        throw new Error('Read requires a small regular text file.')
      }
      const buf = Buffer.alloc(MAX_FILE_BYTES + 1)
      const size = fs.readSync(fd, buf, 0, buf.length, 0)
      if (size > MAX_FILE_BYTES || buf.subarray(0, size).includes(0)) throw new Error('File is too large or binary.')
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, size))
    } finally { fs.closeSync(fd) }
  }

  // Traverse at most 200 entries. Search returns matching paths without releasing file contents.
  search(relative: string, query?: string): string[] {
    const queue = [relative]
    const results: string[] = []
    let scanned = 0
    while (queue.length && scanned < 200 && results.length < 50) {
      const parent = queue.shift()!
      const dir = fs.opendirSync(this.target(parent))
      try {
        let entry: fs.Dirent | null
        while (scanned < 200 && results.length < 50 && (entry = dir.readSync())) {
          scanned++
          if (!safeName(entry.name) || entry.isSymbolicLink()) continue
          const child = path.posix.join(parent, entry.name)
          try { this.target(child) } catch { continue }
          if (entry.isDirectory() && query) queue.push(child)
          if (!entry.isFile() && !entry.isDirectory()) continue
          if (!query || child.includes(query)) results.push(child)
          else if (entry.isFile()) {
            try { if (this.read(child).includes(query)) results.push(child) } catch { /* binary or inaccessible */ }
          }
        }
      } finally { dir.closeSync() }
    }
    return results
  }

  stage(relative: string, content: string) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File proposal exceeds 16 KB.')
    const file = this.target(relative, true)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    const before = stat ? this.read(relative) : null
    // Separate immutable proposal per action. Commit uses the same bytes reviewed in FileChangeReview.
    return {
      file, before, content,
      commit: () => {
        this.target(relative, true)
        const latest = fs.lstatSync(file, { throwIfNoEntry: false })
        if ((stat && (!latest || latest.dev !== stat.dev || latest.ino !== stat.ino || this.read(relative) !== before)) ||
            (!stat && latest)) throw new Error('File changed since review began.')
        const temp = path.join(path.dirname(file), '.ai-worker-' + randomUUID())
        const fd = fs.openSync(temp, 'wx', stat ? stat.mode & 0o777 : 0o600)
        try {
          fs.writeFileSync(fd, content)
          this.target(relative, true)
          if (stat) fs.renameSync(temp, file)
          else fs.linkSync(temp, file) // exclusive create
        } finally {
          fs.closeSync(fd)
          fs.rmSync(temp, { force: true })
        }
      },
    }
  }
}
