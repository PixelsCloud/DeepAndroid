import { PNG } from 'pngjs'
import { pngSize } from './observation.js'

export interface ScreenRegion { x: number; y: number; width: number; height: number }
export interface ObserveOptions { mode?: 'ui' | 'screenshot'; region?: ScreenRegion; scale?: number }
export interface AfterActionOptions { return_screenshot?: boolean; screenshot_delay_ms?: number }
export interface ImageWaitOptions {
  condition: 'image_changed' | 'image_stable'; region?: ScreenRegion
  timeout_ms?: number; interval_ms?: number; stable_ms?: number
  change_ratio?: number; pixel_threshold?: number
}
export function validateRegion(region?: ScreenRegion, size?: { width: number; height: number }) {
  if (!region) return
  if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw new Error('截图区域须为非负整数坐标和正整数宽高')
  if (size && (region.x + region.width > size.width || region.y + region.height > size.height)) throw new Error('截图区域超出原图范围')
}
export function validateObserve(options: ObserveOptions) {
  if (options.mode !== undefined && !['ui', 'screenshot'].includes(options.mode)) throw new Error('观察模式须为 ui 或 screenshot')
  validateRegion(options.region)
  if (options.scale !== undefined && (!Number.isInteger(options.scale) || options.scale < 1 || options.scale > 4)) throw new Error('截图放大倍数须为 1–4 的整数')
}
export function validateAfterAction(options: AfterActionOptions) {
  if (options.return_screenshot !== undefined && typeof options.return_screenshot !== 'boolean') throw new Error('return_screenshot 须为布尔值')
  if (options.screenshot_delay_ms !== undefined && (!options.return_screenshot || !Number.isInteger(options.screenshot_delay_ms) || options.screenshot_delay_ms < 0 || options.screenshot_delay_ms > 5000)) throw new Error('截图延迟须为 0–5000 ms，且须启用 return_screenshot')
}
export function validateImageWait(options: ImageWaitOptions) {
  validateRegion(options.region)
  if (!['image_changed', 'image_stable'].includes(options.condition)) throw new Error('图像等待条件无效')
  const timeout = options.timeout_ms ?? 10000, interval = options.interval_ms ?? Math.min(500, timeout), stable = options.stable_ms ?? Math.min(1000, timeout)
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('图像等待时限须为 100–60000 ms')
  if (!Number.isInteger(interval) || interval < 100 || interval > 5000 || interval > timeout) throw new Error('图像采样间隔须为 100–5000 ms 且不超过等待时限')
  if (!Number.isInteger(stable) || stable < 100 || stable > timeout) throw new Error('图像稳定时长须为 100 ms 至等待时限')
  if (options.condition === 'image_changed' && options.stable_ms !== undefined) throw new Error('stable_ms 仅用于 image_stable')
  const ratio = options.change_ratio ?? 0.01, threshold = options.pixel_threshold ?? 16
  if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) throw new Error('画面变化比例须在 0（含）至 1（不含）之间')
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 254) throw new Error('像素差阈值须为 0–254 的整数')
}
export function decodeScreen(png: Buffer) {
  const size = pngSize(png)
  if (size.width * size.height > 16_777_216 || png.length > 64 * 1024 * 1024) throw new Error('截图超过图像处理大小限制')
  return PNG.sync.read(png)
}
/** Nearest-neighbour zoom preserves source pixels; coordinates always remain in the original screen. */
export function transformScreen(png: Buffer, options: ObserveOptions) {
  validateObserve(options)
  const size = pngSize(png), region = options.region ?? { x: 0, y: 0, ...size }, scale = options.scale ?? 1
  validateRegion(region, size)
  const width = region.width * scale, height = region.height * scale
  if (width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error('放大后的截图超过大小限制，请缩小区域或倍数')
  const image_transform = { region, scale, width, height, original_width: size.width, original_height: size.height, mapping: 'original_x = region.x + image_x / scale; original_y = region.y + image_y / scale' }
  if (!options.region && scale === 1) return { png, image_transform }
  const source = decodeScreen(png), target = new PNG({ width, height })
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = ((region.y + Math.floor(y / scale)) * source.width + region.x + Math.floor(x / scale)) * 4
    source.data.copy(target.data, (y * width + x) * 4, from, from + 4)
  }
  return { png: PNG.sync.write(target), image_transform }
}
/** Fraction of region pixels whose largest RGB channel delta exceeds the threshold. No semantic inference. */
export function imageDifference(before: PNG, after: PNG, region: ScreenRegion, threshold: number) {
  if (before.width !== after.width || before.height !== after.height) throw new Error('图像尺寸发生变化')
  validateRegion(region, before)
  let changed = 0
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
    const i = (y * before.width + x) * 4
    if (Math.max(Math.abs(before.data[i] - after.data[i]), Math.abs(before.data[i + 1] - after.data[i + 1]), Math.abs(before.data[i + 2] - after.data[i + 2])) > threshold) changed++
  }
  return changed / (region.width * region.height)
}

export const regionParameter = { type: 'object', additionalProperties: false, description: 'Region in ORIGINAL screenshot pixels, fully inside the screen.', properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } } as const
export const afterActionParameters = {
  return_screenshot: { type: 'boolean', description: 'Default false. Return a fresh screenshot-only observation after this action, without reading the UI tree. Requires image-capable model. Does not verify app success.' },
  screenshot_delay_ms: { type: 'integer', description: '0–5000 ms; default 300 when return_screenshot=true. Cancellable. Never repeats the action if capture fails.' },
} as const
