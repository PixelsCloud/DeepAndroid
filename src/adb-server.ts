import { setTimeout as delay } from 'node:timers/promises'

const pending = new Map<number, Promise<void>>()

/** Share startup by port, including callers using different ADB installations. */
export function ensureAdbServer(port: number, probe: () => Promise<boolean>, start: () => Promise<unknown>): Promise<void> {
  const existing = pending.get(port)
  if (existing) return existing
  const work = (async () => {
    if (await probe()) return
    try { await start() }
    catch (error) {
      // Another application/process may have won the bind while this one started.
      // Accept only a real responsive ADB server, never an arbitrary port listener.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await probe()) return
        if (attempt < 2) await delay(150)
      }
      throw error
    }
  })()
  pending.set(port, work)
  void work.finally(() => { if (pending.get(port) === work) pending.delete(port) }).catch(() => {})
  return work
}
