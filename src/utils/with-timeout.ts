/**
 * Rejects with `error` when `promise` did not settle in `timeout` ms. Used to bound the waits
 * that would otherwise last as long as the OS keeps a connection attempt alive.
 * The timer is always cleared, a pending one would keep the process alive for nothing.
 */
export default async function withTimeout<T> (
  promise: Promise<T>,
  timeout: number,
  error: Error
): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(error), timeout)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
