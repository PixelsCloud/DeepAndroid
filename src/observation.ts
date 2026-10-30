import { XMLParser } from 'fast-xml-parser'

export interface ScreenElement { element_id: string; text: string; description: string; resource_id: string; package_name: string; class_name: string; clickable: boolean; editable: boolean; focused: boolean; bounds: [number, number, number, number]; scrollable?: boolean; node_path?: string; row_path?: string; scroll_bounds?: [number, number, number, number]; text_truncated?:boolean;description_truncated?:boolean;text_clipped?:boolean }
export interface Observation {
  observation_id: string; serial: string; captured_at: string; width: number; height: number; rotation: number | null;
  elements: ScreenElement[]; tree_truncated: boolean; tree_error: string | null; revision: number; video_epoch: number
  capture_mode?: 'ui' | 'screenshot'
  image_transform?: { region: { x: number; y: number; width: number; height: number }; scale: number; width: number; height: number; original_width: number; original_height: number; mapping: string }
}
export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => data[i] === b)) throw new Error('手机截图不是有效 PNG')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height || width > 16384 || height > 16384) throw new Error('手机截图尺寸异常')
  return { width, height }
}
/** Keep bounded, visible screen data. XML attributes are data, never executable instructions. */
export function parseHierarchy(xml: string, width: number, height: number): { elements: ScreenElement[]; truncated: boolean; rotation: number } {
  if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('界面结构超过限制或包含不支持的声明')
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false }).parse(xml)
  if (!parsed || typeof parsed !== 'object' || !('hierarchy' in parsed)) throw new Error('手机未返回有效界面结构')
  const hierarchy = parsed.hierarchy as Record<string, unknown>
  const elements: ScreenElement[] = []
  let truncated = false, visited = 0
  function walk(value: unknown, depth: number, path = '0', scroll?: { path: string; bounds: [number, number, number, number] }, rowPath?: string) {
    if (Array.isArray(value)) { value.forEach((node, index) => walk(node, depth, `${path}.${index}`, scroll, rowPath)); return }
    if (!value || typeof value !== 'object') return
    if (++visited > 3000 || depth > 100) { truncated = true; return }
    const node = value as Record<string, unknown>
    if(node['visible-to-user']==='false')return
    const password = node.password === 'true'
    const editable = /(?:EditText|AutoCompleteTextView)$/.test(String(node.class))
    const text = password ? '' : String(node.text ?? '').slice(0, 1000)
    const description = password ? '' : String(node['content-desc'] ?? '').slice(0, 500)
    const bounds = String(node.bounds ?? '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
    let childScroll = scroll
    if (bounds && node.enabled !== 'false' && node['visible-to-user'] !== 'false' && (text || description || node.clickable === 'true' || node.scrollable === 'true' || editable)) {
      const [left, top, right, bottom] = bounds.slice(1).map(Number)
      const clipped: [number, number, number, number] = [Math.max(left, scroll?.bounds[0] ?? 0), Math.max(top, scroll?.bounds[1] ?? 0), Math.min(right, width, scroll?.bounds[2] ?? width), Math.min(bottom, height, scroll?.bounds[3] ?? height)]
      if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) {
        if (elements.length >= 240) truncated = true
        else elements.push({ element_id: `e${elements.length + 1}`, text, description, resource_id: String(node['resource-id'] ?? ''), package_name: String(node.package ?? ''), class_name: String(node.class ?? ''), clickable: node.clickable === 'true', editable, focused: node.focused === 'true', bounds: clipped, scrollable: node.scrollable === 'true', node_path: path, row_path: rowPath, scroll_bounds: scroll?.bounds,...(!password&&String(node.text??'').length>1000?{text_truncated:true}:{}),...(!password&&String(node['content-desc']??'').length>500?{description_truncated:true}:{}),...([left,top,right,bottom].some((value,index)=>value!==clipped[index])?{text_clipped:true}:{}) })
        if (node.scrollable === 'true') childScroll = { path, bounds: clipped }
      }
    }
    if ('node' in node) {
      const children = Array.isArray(node.node) ? node.node : [node.node]
      children.forEach((child, index) => {
        const childPath = `${path}.${index}`
        walk(child, depth + 1, childPath, childScroll, childScroll?.path === path ? childPath : rowPath)
      })
    }
  }
  walk(hierarchy.node, 0)
  return { elements, truncated, rotation: Number(hierarchy.rotation ?? 0) }
}
