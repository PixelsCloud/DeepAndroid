import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InputController, parseInput, mapPoint } from '../dist/input.js'
const geometry = { width: 576, height: 1280, epoch: 1 }
const pointer = phase => ({ kind: 'pointer', phase, x: 120, y: 350, ...geometry })
function fixture() {
  const calls = []
  const writer = Object.fromEntries(['injectTouch', 'injectScroll', 'injectKeyCode', 'setClipboard', 'injectText'].map(name => [name, async value => { calls.push({ name, value }) }]))
  return { input: new InputController(writer), writer, calls }
}
test('contain geometry maps scaled video, excludes black bars and clamps captured drags', () => {
  const rect = { left: 10, top: 20, width: 400, height: 400 }
  assert.deepEqual(mapPoint(210, 220, rect, geometry), { ...geometry, x: 288, y: 640 })
  assert.equal(mapPoint(11, 220, rect, geometry), undefined)
  assert.deepEqual(mapPoint(-100, 900, rect, geometry, true), { ...geometry, x: 0, y: 1279 })
  assert.equal(mapPoint(210, 220, { ...rect, width: 0 }, geometry), undefined)
})
test('portrait and landscape use their own video coordinate system', () => {
  assert.deepEqual(mapPoint(320, 144, { left: 0, top: 0, width: 640, height: 288 }, { width: 1280, height: 576, epoch: 2 }), { width: 1280, height: 576, epoch: 2, x: 640, y: 288 })
})
test('control wire rejects unsafe numbers, unknown operations and unsupported keys', () => {
  const valid = { type: 'input', id: 1, command: pointer('down') }
  assert.deepEqual(parseInput(valid), valid)
  for (const command of [{ ...pointer('down'), x: -1 }, { ...pointer('down'), x: NaN }, { ...pointer('down'), width: 65536 }, { ...pointer('down'), phase: 'invalid' }, { kind: 'key', key: 'constructor' }, { kind: 'text', method: 'type', text: '中文' }, { kind: 'shell', command: 'anything' }]) assert.throws(() => parseInput({ ...valid, command }))
})
test('pointer down, moves and up are written in order with finger identity', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280)
  await Promise.all(['down', 'move', 'up'].map(phase => input.send(pointer(phase))))
  assert.deepEqual(calls.map(c => c.value.action), [0, 2, 1])
  assert(calls.every(c => c.value.pointerId === -2n && c.value.videoWidth === 576))
  assert.equal(calls.at(-1).value.pressure, 0)
  await input.close()
})
test('rotation releases the previous gesture and rejects its old geometry', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280); await input.send(pointer('down'))
  await input.setGeometry(1280, 576)
  await assert.rejects(input.send(pointer('move')), /旋转/)
  assert.deepEqual(calls.map(c => c.value.action), [0, 1])
  assert.equal(input.geometry.epoch, 2)
  await input.close()
})
test('losing focus releases once; new moves cannot extend a released gesture', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280); await input.send(pointer('down'))
  await input.send({ kind: 'release' }); await input.send({ kind: 'release' })
  await assert.rejects(input.send(pointer('move')), /重新按下/)
  assert.deepEqual(calls.map(c => c.value.action), [0, 1])
  await input.close()
})
test('closing a session releases fingers and rejects later commands', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280); await input.send(pointer('down'))
  await input.close()
  assert.deepEqual(calls.map(c => c.value.action), [0, 1])
  await assert.rejects(input.send({ kind: 'key', key: 'home' }), /关闭/)
})
test('a rejected command does not block the next valid command', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280)
  await assert.rejects(input.send(pointer('up')))
  await input.send({ kind: 'key', key: 'back' })
  assert.deepEqual(calls.map(c => c.value.action), [0, 1])
  await input.close()
})
test('Chinese paste and physical keyboard text use distinct input methods', async () => {
  const { input, calls } = fixture()
  await input.send({ kind: 'text', method: 'paste', text: '中文 Pixels\n第二行🙂' })
  await input.send({ kind: 'text', method: 'type', text: 'abc' })
  assert.equal(calls[0].name, 'setClipboard')
  assert.deepEqual(calls[0].value, { sequence: 0n, paste: true, content: '中文 Pixels\n第二行🙂' })
  assert.equal(calls[1].name, 'injectText'); assert.equal(calls[1].value, 'abc')
  await input.close()
})
test('permission denial blocks new actions while allowing release', async () => {
  const { input, calls } = fixture()
  await input.setGeometry(576, 1280); await input.send(pointer('down'))
  input.block('USB permission denied')
  await assert.rejects(input.send({ kind: 'key', key: 'home' }), /permission/)
  await input.send({ kind: 'release' })
  assert.equal(calls.at(-1).value.action, 1)
  await input.close()
})
