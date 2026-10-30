export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024

export function previewableImage(entry: {type: string; name: string}) {
  return entry.type === 'file' && /\.(jpe?g|png|gif|webp)$/i.test(entry.name)
}

// Use file signatures, never a user-controlled extension, for the response MIME.
export function imageMime(data: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end))
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  throw new Error('无法预览此文件：仅支持 JPEG、PNG、GIF 和 WebP 图片')
}
