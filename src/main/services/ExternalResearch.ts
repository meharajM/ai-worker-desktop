import { resolve4 } from 'node:dns/promises'
import { get } from 'node:https'
import { isIPv4 } from 'node:net'
import type { Browser, BrowserContext } from 'playwright-core'

export function publicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const [a, b, c] = ip.split('.').map(Number)
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
}

export function researchUrl(raw: string): URL {
  const url = new URL(raw)
  if (raw.length > 2048 || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
      /\.(?:localhost|local|internal|test|invalid|onion)$/i.test(url.hostname)) {
    throw new Error('Research requires a public HTTPS page.')
  }
  url.hash = ''
  return url
}

async function getDocument(url: URL, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const addresses = await resolve4(url.hostname)
  if (!addresses.length || !addresses.every(publicIPv4)) throw new Error('Address is outside the public internet.')
  signal.throwIfAborted()
  // Connect directly to the checked IP; retain the original host for TLS and HTTP.
  return new Promise((resolve, reject) => {
    const req = get({
      hostname: addresses[0], servername: url.hostname, path: url.pathname + url.search, port: 443,
      agent: false, signal, headers: { Host: url.host, Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' },
    }, res => {
      const type = res.headers['content-type'] || ''
      if (res.statusCode !== 200 || !/^text\/(html|plain)(?:\s*;|$)/i.test(type) || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.destroy()
        reject(new Error('Research requires a direct HTML or text response.'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('error', reject)
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 512 * 1024) res.destroy(new Error('Public page exceeds 512 KB.'))
        else chunks.push(chunk)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
  })
}

export async function research(raw: string, signal: AbortSignal) {
  const url = researchUrl(raw)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
  const html = await getDocument(url, bounded)
  bounded.throwIfAborted()
  const { chromium } = require('playwright-core') as typeof import('playwright-core')
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const close = () => { void browser?.close().catch(() => {}) }
  bounded.addEventListener('abort', close, { once: true })
  try {
    try { browser = await chromium.launch({ timeout: 5000 }) }
    catch {
      bounded.throwIfAborted()
      browser = await chromium.launch({ channel: 'chrome', timeout: 5000 })
    }
    bounded.throwIfAborted()
    context = await browser.newContext({ offline: true, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false })
    const page = await context.newPage()
    // Parse inert markup on a blank page. The browser never navigates to untrusted URLs.
    const data = await page.evaluate(({ html, base }) => {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      doc.querySelectorAll('script,style,noscript,template').forEach(node => node.remove())
      const links = Array.from(doc.querySelectorAll('a[href]')).slice(0, 120).flatMap(anchor => {
        try {
          let link = new URL(anchor.getAttribute('href')!, base)
          if (link.hostname === 'duckduckgo.com' && link.searchParams.has('uddg')) link = new URL(link.searchParams.get('uddg')!)
          const text = anchor.textContent?.trim().slice(0, 120)
          return text && link.protocol === 'https:' && link.href.length <= 2048 ? [{ text, url: link.href }] : []
        } catch { return [] }
      }).slice(0, 12)
      return { text: (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 6000), links }
    }, { html, base: url.href })
    bounded.throwIfAborted()
    return { url: url.href, ...data }
  } finally {
    bounded.removeEventListener('abort', close)
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}
