import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureAdbServer } from '../dist/adb-server.js'
import { diagnoseError } from '../dist/diagnostics.js'

test('a responsive ADB server is reused without starting another process', async () => {
  let starts = 0
  await ensureAdbServer(15037, async () => true, async () => { starts++ })
  assert.equal(starts, 0)
})

test('simultaneous device lists share startup by port and a later stop can recover', async () => {
  let release, starts = 0
  const gate = new Promise(resolve => { release = resolve })
  const start = async () => { starts++; await gate }
  const calls = Array.from({ length: 12 }, () => ensureAdbServer(15038, async () => false, start))
  await Promise.resolve()
  assert.equal(starts, 1)
  release()
  await Promise.all(calls)
  await ensureAdbServer(15038, async () => false, async () => { starts++ })
  assert.equal(starts, 2)
})

test('a competing startup failure succeeds only when the ADB protocol responds', async () => {
  let probes = 0
  await ensureAdbServer(15039, async () => ++probes > 1, async () => { throw new Error('cannot bind to 5037') })
  const failure = new Error('could not read ok from ADB Server; failed to start daemon')
  await assert.rejects(ensureAdbServer(15040, async () => false, async () => { throw failure }), error => error === failure)
  assert.equal(diagnoseError(failure).code, 'ADB_SERVER_START_FAILED')
  await ensureAdbServer(15040, async () => true, async () => { throw failure })
})
