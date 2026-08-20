import createDebug from 'debug'
import Shared from './shared'
import type { ClientContext } from '../context'
import type { ShareProvider } from './provider'

const debug = createDebug('slsk:share')

/**
 * The files this client offers the network: the providers listing them, and what the server is
 * told about how much there is.
 */
export default class Sharing {
  readonly shared = new Shared()
  /**
   * Resolves once the first listing is over and its counts have been announced, rejects when
   * that listing failed.
   */
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (err: Error) => void

  constructor (private readonly ctx: ClientContext) {
    // the providers are added here, not on login: `shares` is documented as usable at any time,
    // and a provider given in the options must not be thrown away
    this.providers.forEach(provider => this.shared.addProvider(provider))

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // nobody has to await it, the events report the same thing
    this.ready.catch(() => {})
  }

  /** Share providers given in the options, whether one or several were passed */
  private get providers (): ShareProvider[] {
    const shares = this.ctx.options.shares
    if (!shares) return []
    return Array.isArray(shares) ? shares : [shares]
  }

  /**
   * Lists the shares again and tells the server how much is shared, to pick up files added
   * or removed since the last listing.
   */
  async refresh (): Promise<void> {
    await this.shared.refresh()
    this.announce()
  }

  /** Tells the server how many files this client shares, which is what makes them searchable */
  announce (): void {
    const stats = this.shared.stats()
    debug(`sharing ${stats.files} files in ${stats.folders} folders`)
    if (!this.ctx.server) {
      debug('not connected yet, the counts go out with the login')
      return
    }
    this.ctx.server.sharedFoldersFiles(stats.folders, stats.files)
  }

  /**
   * Lists the providers and announces what they hold. Runs in the background of the login: a
   * few thousand files on a slow volume take minutes, and the slsk server drops a connection
   * that stays unauthenticated that long.
   */
  async list (): Promise<void> {
    try {
      await this.shared.refresh()
      this.announce()
      this.ctx.emit('shares-ready', this.shared.stats())
      this.resolveReady()
    } catch (err) {
      debug(`cannot list the shares: ${String(err)}`)
      this.ctx.emit('shares-error', err as Error)
      this.rejectReady(err as Error)
    }
  }

  close (): void {
    this.shared.close().catch(err => debug(`cannot close the shares: ${String(err)}`))
  }
}
