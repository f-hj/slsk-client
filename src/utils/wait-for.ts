import type EventEmitter from 'events'

/** Minimal view of an emitter, to keep the helper usable with any typed event map */
interface AnyEmitter {
  on: (event: string, listener: (...args: any[]) => void) => unknown
  off: (event: string, listener: (...args: any[]) => void) => unknown
}

export interface WaitForOptions<Args extends any[]> {
  /** ms before the returned promise rejects */
  timeout: number
  /** Error used on timeout (default: `Timed out waiting for {event}`) */
  timeoutError?: Error
  /** Only settle on an emission the predicate accepts, keep waiting otherwise */
  match?: (...args: Args) => boolean
}

/**
 * Resolves with the arguments of the first matching emission of `event`, rejects when it does
 * not happen in time. The listener and the timer are always removed, so no cleanup is left to
 * the caller.
 */
export default async function waitFor<
  M extends Record<string, any[]>,
  K extends keyof M & string
> (
  emitter: EventEmitter<M>,
  event: K,
  options: WaitForOptions<M[K]>
): Promise<M[K]> {
  const target = emitter as unknown as AnyEmitter

  return await new Promise<M[K]>((resolve, reject) => {
    const listener = (...args: any[]): void => {
      const emitted = args as M[K]
      if (options.match && !options.match(...emitted)) return
      cleanup()
      resolve(emitted)
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(options.timeoutError ?? new Error(`Timed out waiting for ${event}`))
    }, options.timeout)

    const cleanup = (): void => {
      clearTimeout(timer)
      target.off(event, listener)
    }

    target.on(event, listener)
  })
}
