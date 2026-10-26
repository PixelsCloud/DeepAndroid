import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePacket, decodePacket } from '../dist/wire.js'
import { authorized, createPanel } from '../dist/host.js'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'

test('configuration and frame boundaries, keyframes and 64-bit timestamps survive transport', () => {
  for (const packet of [
    { type: 'configuration', data: new Uint8Array([0, 0, 0, 1, 103]) },
    { type: 'data', data: new Uint8Array([1, 2, 3]), keyframe: true, pts: 2n ** 60n },
    { type: 'data', data: new Uint8Array([4]), keyframe: false, pts: 9000n },
  ]) assert.deepEqual(decodePacket(encodePacket(packet).buffer), packet)
})
test('invalid video packets are rejected', () => {
  for (const data of [new Uint8Array(0), new Uint8Array(10), new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1])]) {
    assert.throws(() => decodePacket(data.buffer))
  }
})
test('foreign origins and missing client headers cannot issue video tickets', () => {
  assert.equal(authorized({ headers: { host: '127.0.0.1:3080' } }), false)
  assert.equal(authorized({ headers: { host: '127.0.0.1:3080', origin: 'https://other.example', 'x-android-client': '1' } }), false)
  assert.equal(authorized({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-android-client': '1' } }), true)
  assert.equal(authorized({ headers: { 'x-android-client': '1' } }), true)
})
test('HTTP controls validate input and websocket requires a revocable ticket', async () => {
  const panel = await createPanel()
  const http = createServer(panel.handler)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${http.address().port}/x-android`
  const headers = { 'x-android-client': '1', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(url + '/health')).status, 403)
    assert.equal((await fetch(url + '/ticket', { method: 'POST', headers, body: '{"serial":5}' })).status, 400)
    const health = await (await fetch(url + '/health', { headers })).json()
    assert.equal(health.state, 'idle')
    const response = await fetch(url + '/ticket', { method: 'POST', headers, body: '{"serial":"test-device"}' })
    const ticket = await response.json()
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(ticket.url.replace(/ticket=.*/, 'ticket=wrong'))
      ws.once('open', () => { ws.close(); reject(new Error('Unauthenticated socket opened')) })
      ws.once('error', error => { assert.match(error.message, /403/); resolve() })
    })
    const stopped = await fetch(url + '/disconnect', { method: 'POST', headers, body: '{}' })
    assert.equal(stopped.status, 200)
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(ticket.url)
      ws.once('open', () => { ws.close(); reject(new Error('Revoked ticket opened')) })
      ws.once('error', error => { assert.match(error.message, /403/); resolve() })
    })
  } finally { await panel.close(); await new Promise(resolve => http.close(resolve)) }
})
