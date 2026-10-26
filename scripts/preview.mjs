import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createPanel } from '../dist/host.js'
const panel = await createPanel()
let fixtureState = {}
const server = createServer(async (req, res) => {
  if (req.url === '/fixture') { res.setHeader('content-type','text/html; charset=utf-8'); res.end(await readFile(new URL('../tests/control-fixture.html',import.meta.url))); return }
  if (req.url === '/fixture-state') {
    if (req.method === 'POST') { let body=''; for await (const chunk of req) { body+=chunk; if(body.length>32768){res.writeHead(413);res.end();return} } fixtureState=JSON.parse(body) }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureState));return
  }
  if (req.url?.startsWith('/x-android/')) return panel.handler(req, res)
  if (req.url === '/ui.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../dist/ui.js', import.meta.url))); return }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (req.url !== '/') { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>Android M0 验证</title><style>html,body{margin:0;height:100%;background:#15191e;color:#e4e8eb}#root{height:100%;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import {mountPanel} from "/ui.js";window.disposePanel=mountPanel(document.getElementById("root"));</script></html>')
})
server.listen(0, '127.0.0.1', () => console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`))
async function close() { await panel.close(); server.close(); }
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
