import type { ScrcpyVideoStreamPacket } from '@yume-chan/scrcpy'
export function encodeAudio(pts:bigint,data:Uint8Array){const result=new Uint8Array(10+data.length);result[0]=2;new DataView(result.buffer).setBigUint64(2,pts);result.set(data,10);return result}

/** A small binary envelope preserves scrcpy's packet boundaries and timestamps. */
export function encodePacket(packet: Exclude<ScrcpyVideoStreamPacket, { type: 'session' }>): Uint8Array {
  const result = new Uint8Array(10 + packet.data.byteLength)
  result[0] = packet.type === 'configuration' ? 0 : 1
  result[1] = packet.type === 'data' && packet.keyframe ? 1 : 0
  new DataView(result.buffer).setBigUint64(2, packet.type === 'data' ? packet.pts ?? 0n : 0n)
  result.set(packet.data, 10)
  return result
}

/** Reject malformed envelopes before they enter the browser decoder. */
export function decodePacket(data: ArrayBuffer): Exclude<ScrcpyVideoStreamPacket, { type: 'session' }> {
  if (data.byteLength < 11 || data.byteLength > 16 * 1024 * 1024) throw new Error('Invalid video packet size')
  const view = new DataView(data)
  const payload = new Uint8Array(data, 10)
  if (view.getUint8(0) === 0) return { type: 'configuration', data: payload }
  if (view.getUint8(0) !== 1 || view.getUint8(1) > 1) throw new Error('Invalid video packet type')
  return { type: 'data', keyframe: view.getUint8(1) === 1, pts: view.getBigUint64(2), data: payload }
}
