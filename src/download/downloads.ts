import createDebug from 'debug'
import Download, { type DownloadInit } from './download'

const debug = createDebug('slsk:downloads')

/**
 * The downloads of one client, indexed by peer and file and by the transfer tokens the peer
 * chose. Nested maps rather than a `user + '_' + file` key: a user named `a_b` sharing `c`
 * would otherwise collide with a user named `a` sharing `b_c`.
 */
export default class Downloads {
  private readonly byUser = new Map<string, Map<string, Download>>()
  private readonly byToken = new Map<string, Download>()

  /** Registers a new download, replacing a previous one for the same file */
  start (init: DownloadInit): Download {
    const download = new Download(init)

    // whoever waited on the previous attempt would wait forever otherwise
    this.get(init.user, init.file)?.fail(new Error('Replaced by a new download'))

    const files = this.byUser.get(init.user) ?? new Map<string, Download>()
    files.set(init.file, download)
    this.byUser.set(init.user, files)

    // stop tracking it as soon as it is over, whatever the outcome
    download.once('complete', () => this.forget(download))
    download.once('failed', () => this.forget(download))

    debug(`start ${init.user} ${init.file}`)
    return download
  }

  get (user: string, file: string): Download | undefined {
    return this.byUser.get(user)?.get(file)
  }

  /** Download the peer announced with this transfer token */
  byTransferToken (token: string): Download | undefined {
    return this.byToken.get(token)
  }

  /** Remembers the token a peer chose for a transfer, so its file connection is recognized */
  bindToken (token: string, download: Download): void {
    debug(`bind token ${token} to ${download.user} ${download.file}`)
    this.byToken.set(token, download)
  }

  forgetToken (token: string): void {
    this.byToken.delete(token)
  }

  /**
   * Drops every token bound to a download, before asking for it again: the peer picks a new
   * token for the new attempt and the old one must not resolve anything.
   */
  forgetTokensOf (download: Download): void {
    this.byToken.forEach((bound, token) => {
      if (bound === download) this.byToken.delete(token)
    })
  }

  /** Every download still running */
  get pending (): Download[] {
    return [...this.byUser.values()].flatMap(files => [...files.values()])
  }

  forget (download: Download): void {
    const files = this.byUser.get(download.user)
    if (files?.get(download.file) === download) {
      files.delete(download.file)
      if (files.size === 0) this.byUser.delete(download.user)
    }

    this.forgetTokensOf(download)
  }

  /** Fails everything still running, used when the client is destroyed */
  failAll (err: Error): void {
    this.pending.forEach(download => download.fail(err))
  }
}
