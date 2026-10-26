import type { ScreenElement } from './observation.js'
import { normalizeName } from './apps.js'
export interface TargetQuery { text?: string; resource_id?: string; class_name?: string; package_name?: string; editable?: boolean; exact?: boolean }
export function validateTarget(query: TargetQuery) {
  const selectors = [query.text, query.resource_id, query.class_name, query.package_name]
  if (!selectors.some(value => value !== undefined && value.trim()) && query.editable === undefined) throw new Error('请提供文字、资源 ID、类名、包名或 editable 筛选条件')
  if (selectors.some(value => value !== undefined && (!value.trim() || value.length > 256))) throw new Error('查找条件长度须在 1–256 之间')
}
/** Literal matching only; multiple constraints must all match the same visible element. */
export function matchTargets(elements: ScreenElement[], query: TargetQuery): ScreenElement[] {
  return elements.filter(element => {
    if (query.editable !== undefined && query.editable !== element.editable) return false
    if (query.resource_id !== undefined && query.resource_id !== element.resource_id) return false
    if (query.class_name !== undefined && query.class_name !== element.class_name) return false
    if (query.package_name !== undefined && query.package_name !== element.package_name) return false
    if (query.text !== undefined) {
      const wanted = normalizeName(query.text), texts = [normalizeName(element.text), normalizeName(element.description)]
      if (!texts.some(value => query.exact ? value === wanted : value.includes(wanted))) return false
    }
    return true
  })
}
