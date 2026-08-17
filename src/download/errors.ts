/**
 * Failures a download settles with that the caller may want to tell apart from a peer error:
 * both reject `Download.promise` and are reported by the `failed` event.
 */

/** The caller gave up on the transfer, with `Download.cancel()` or by aborting its signal */
export class DownloadCancelledError extends Error {
  override readonly name = 'DownloadCancelledError'

  constructor (message = 'Download cancelled') {
    super(message)
  }
}

/** Nothing happened on the transfer for `DownloadOptions.timeout` ms */
export class DownloadTimeoutError extends Error {
  override readonly name = 'DownloadTimeoutError'
  /** The inactivity timeout that expired, in ms */
  readonly timeout: number

  constructor (timeout: number, status: string) {
    super(`Download timed out after ${timeout}ms without any progress (${status})`)
    this.timeout = timeout
  }
}
