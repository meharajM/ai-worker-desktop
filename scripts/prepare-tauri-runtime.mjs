#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(ROOT, '.build', 'tauri-runtime')
const VERSION = process.versions.node

function targetDetails() {
  const triple = process.env.AI_WORKER_TARGET_TRIPLE
  if (!triple) return { platform: process.platform, arch: process.arch }

  const platform = triple.includes('apple-darwin')
    ? 'darwin'
    : triple.includes('windows')
      ? 'win32'
      : triple.includes('linux')
        ? 'linux'
        : null
  const arch = triple.startsWith('aarch64-') || triple.startsWith('arm64-')
    ? 'arm64'
    : triple.startsWith('x86_64-') || triple.startsWith('x64-')
      ? 'x64'
      : null

  if (!platform || !arch) throw new Error(`Unsupported MCP runtime target: ${triple}`)
  return { platform, arch }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Could not download the Node.js runtime (HTTP ${response.status}).`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function main() {
  const target = targetDetails()
  const runtimeName = target.platform === 'win32' ? 'node.exe' : 'node'

  await rm(OUTPUT, { recursive: true, force: true })
  await mkdir(OUTPUT, { recursive: true })
  const runtimePath = path.join(OUTPUT, runtimeName)

  if (target.platform === process.platform && target.arch === process.arch) {
    await copyFile(process.execPath, runtimePath)
    if (target.platform !== 'win32') await chmod(runtimePath, 0o755)

    const licenseCandidates = [
      path.resolve(path.dirname(process.execPath), '..', 'LICENSE'),
      path.resolve(path.dirname(process.execPath), '..', '..', 'LICENSE'),
    ]
    let copiedLicense = false
    for (const licensePath of licenseCandidates) {
      try {
        await copyFile(licensePath, path.join(OUTPUT, 'NODE-LICENSE.txt'))
        copiedLicense = true
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (!copiedLicense) {
      await writeFile(path.join(OUTPUT, 'NODE-LICENSE.txt'), `Node.js ${VERSION} is distributed under the MIT license.\nhttps://github.com/nodejs/node/blob/v${VERSION}/LICENSE\n`)
    }
  } else {
    if (target.platform === 'win32') {
      throw new Error('Cross-building the Windows MCP runtime is not supported; build on a Windows runner.')
    }

    const archiveName = `node-v${VERSION}-${target.platform}-${target.arch}.tar.gz`
    const archiveRoot = `node-v${VERSION}-${target.platform}-${target.arch}`
    const baseUrl = `https://nodejs.org/dist/v${VERSION}`
    const temporary = path.join(ROOT, '.build', 'node-runtime-download')
    const archivePath = path.join(temporary, archiveName)
    const sumsPath = path.join(temporary, 'SHASUMS256.txt')
    const extractPath = path.join(temporary, 'extract')

    await rm(temporary, { recursive: true, force: true })
    await mkdir(extractPath, { recursive: true })
    await download(`${baseUrl}/${archiveName}`, archivePath)
    await download(`${baseUrl}/SHASUMS256.txt`, sumsPath)

    const sums = await readFile(sumsPath, 'utf8')
    const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(` ${archiveName}`))?.split(/\s+/)[0]
    if (!expected) throw new Error('Node.js did not publish a checksum for the requested runtime.')
    const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex')
    if (actual !== expected) throw new Error('The downloaded Node.js runtime failed its SHA-256 check.')

    const extraction = spawnSync('tar', [
      '-xzf', archivePath,
      '-C', extractPath,
      '--strip-components=1',
      `${archiveRoot}/LICENSE`,
      `${archiveRoot}/bin/node`,
    ], { encoding: 'utf8' })
    if (extraction.error || extraction.status !== 0) {
      throw extraction.error || new Error(`Could not unpack the Node.js runtime: ${extraction.stderr || 'tar failed'}`)
    }
    await copyFile(path.join(extractPath, 'bin', 'node'), runtimePath)
    await copyFile(path.join(extractPath, 'LICENSE'), path.join(OUTPUT, 'NODE-LICENSE.txt'))
    await rm(temporary, { recursive: true, force: true })
    if (target.platform !== 'win32') await chmod(runtimePath, 0o755)
  }

  await writeFile(path.join(OUTPUT, 'NOTICE.txt'), `Bundled Node.js ${VERSION} (${target.platform}-${target.arch}) for the local MCP adapter.\nNode.js license: see NODE-LICENSE.txt.\n`)
  console.log(`Prepared bundled Node.js ${VERSION} for ${target.platform}-${target.arch}.`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not prepare the bundled Node.js runtime.')
  process.exitCode = 1
})
