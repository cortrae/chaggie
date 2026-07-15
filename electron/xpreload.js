const { ipcRenderer } = require('electron')

const seen = new Set()
let lastEmit = 0
const RATE_MS = 250

function emit(username, text) {
  if (!text) return
  const key = `${username}|${text}`.slice(0, 120)
  if (seen.has(key)) return
  seen.add(key)
  if (seen.size > 2000) seen.clear()
  ipcRenderer.sendToHost('x-chat', { username: username || 'x_user', text, ts: Date.now() })
}

const NativeWS = window.WebSocket
function PatchedWS(url, protocols) {
  const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url)
  ws.addEventListener('message', (ev) => {
    try {
      let d = ev.data
      if (d instanceof Blob) {
        d.text().then(t => handleFrame(t, url)).catch(() => {})
      } else if (d instanceof ArrayBuffer) {
        handleFrame(new TextDecoder().decode(d), url)
      } else {
        handleFrame(d, url)
      }
    } catch (e) {}
  })
  return ws
}
PatchedWS.prototype = NativeWS.prototype
PatchedWS.CONNECTING = NativeWS.CONNECTING
PatchedWS.OPEN = NativeWS.OPEN
PatchedWS.CLOSING = NativeWS.CLOSING
PatchedWS.CLOSED = NativeWS.CLOSED
window.WebSocket = PatchedWS

function handleFrame(data, url) {
  if (typeof data !== 'string') return
  let obj
  try { obj = JSON.parse(data) } catch { return }
  extractChatman(obj)
}

function extractChatman(obj) {
  try {
    // kind:2 = presence/occupancy frames. Emit viewer count, then stop.
    if (obj.kind === 2) { console.log('[X-OCC]', obj.payload)
      let payload = obj.payload
      if (typeof payload === 'string') payload = JSON.parse(payload)
      let body = payload && payload.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch {}
      }
      const occ = (body && (body.occupancy ?? body.participants ?? body.total))
        ?? payload.occupancy ?? payload.participants ?? payload.total
      if (occ != null) ipcRenderer.sendToHost('x-viewers', { occupancy: Number(occ) })
      return
    }

    // kind:1 = chat messages
    if (obj.kind !== 1) return
    let payload = obj.payload
    if (typeof payload === 'string') payload = JSON.parse(payload)
    let body = payload.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch {}
    }
    if (body && typeof body === 'object') {
      const text = body.body || body.message || body.text
      const username = body.displayName || body.username || (body.user && body.user.username)
      if (text) emit(username, text)
    }
  } catch (e) {}
}
// DOM observer fallback in case the socket isn't caught
function startDomObserver() {
  const SELECTORS = [
    '[data-testid="liveComment"]',
    '[class*="LiveComment"]',
    '[class*="ChatMessage"]',
  ]
  const tryRead = () => {
    for (const sel of SELECTORS) {
      const els = document.querySelectorAll(sel)
      if (els.length) {
        els.forEach(el => {
          const lines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)
          if (lines.length >= 2) emit(lines[0], lines.slice(1).join(' '))
        })
        return true
      }
    }
    return false
  }
  const obs = new MutationObserver(() => {
    const now = Date.now()
    if (now - lastEmit < RATE_MS) return
    lastEmit = now
    tryRead()
  })
  if (document.body) obs.observe(document.body, { childList: true, subtree: true })
}

if (document.readyState === 'complete' || document.readyState === 'interactive') startDomObserver()
else window.addEventListener('DOMContentLoaded', startDomObserver)