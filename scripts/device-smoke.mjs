import assert from 'node:assert/strict'
import { DeviceService } from '../dist/device.js'
const service = new DeviceService()
const devices = await service.list()
console.log('Devices:', devices)
const serial = process.argv[2] ?? devices.find(d => d.state === 'device')?.serial
assert(serial, 'No authorized device')
for (let round = 1; round <= 3; round++) {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(new Error('Smoke timeout')), 20000)
  const start = performance.now()
  let session
  try {
    session = await service.open(serial, abort.signal)
    let configs = 0, frames = 0, dimensions
    while (frames < 5) {
      const { done, value } = await session.read()
      assert(!done, 'Stream ended before frames')
      if (value.type === 'configuration') configs++
      if (value.type === 'data') frames++
      if (value.type === 'session') dimensions = [value.width, value.height]
    }
    assert(configs > 0, 'No codec configuration')
    assert(dimensions?.every(x => x > 0), 'No video dimensions')
    console.log(JSON.stringify({ round, serial, codec: session.codec, dimensions, frames, configs, timeMs: Math.round(performance.now() - start) }))
  } finally { clearTimeout(timeout); abort.abort(); await session?.close() }
}
console.log('PASS: real USB video, disconnect and reconnect (3 rounds)')
