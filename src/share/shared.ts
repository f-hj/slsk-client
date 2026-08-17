import EventEmitter from 'events'
import createDebug from 'debug'
import ShareIndex, { type IndexedEntry } from './share-index'
import fsShareProvider from './providers/fs'
import type { ShareEntry, ShareProvider } from './provider'

const debug = createDebug('slsk:shared:i')

export interface SharedEvents {
  /** Emitted for every file found while listing the providers */
  file: [file: ShareEntry]
  /** Emitted once a folder added with scanFolder has been listed */
  complete: [folder: string]
}

/**
 * What is shared with the other peers: a {@link ShareIndex} fed by any number of
 * {@link ShareProvider}, plus the helpers to share a folder of the local file system at runtime.
 */
export default class Shared extends EventEmitter<SharedEvents> {
  private readonly index = new ShareIndex()
  /** Provider holding the entries set through `files`, created on first use */
  private staticProvider?: ShareProvider

  /** Every shared file */
  get files (): ShareEntry[] {
    return this.index.files
  }

  /** Replaces the files shared without going through a provider */
  set files (entries: ShareEntry[]) {
    if (!this.staticProvider) {
      this.staticProvider = { name: 'static', list: () => [], read: () => { throw new Error('not readable') } }
    }
    this.index.set(this.staticProvider, entries)
  }

  /** Adds a provider, its files are listed by the next `refresh()` */
  addProvider (provider: ShareProvider): void {
    debug(`add provider ${provider.name ?? 'unnamed'}`)
    this.index.add(provider)
  }

  /** Lists every provider again, to pick up files added or removed since the last listing */
  async refresh (): Promise<void> {
    await this.index.refresh()
  }

  /** Shares a folder of the local file system and lists it right away */
  async scanFolder (folder: string): Promise<void> {
    const provider = fsShareProvider({ folders: [folder] })
    this.index.add(provider)
    await this.index.refresh(provider)

    this.files
      .filter(entry => this.index.resolve(entry.path)?.provider === provider)
      .forEach(entry => this.emit('file', entry))

    debug(`Scan folder ${folder} completed, ${this.index.stats().files} shared`)
    this.emit('complete', folder)
  }

  /** Files matching a search query */
  async search (query: string): Promise<ShareEntry[]> {
    return await this.index.search(query)
  }

  /** Finds a shared file from the path a peer sent back */
  resolve (path: string): IndexedEntry | undefined {
    return this.index.resolve(path)
  }

  /** Distinct folders containing at least one shared file */
  folders (): string[] {
    return this.index.folders()
  }

  /** Shared files of a folder, as requested by a peer browsing our shares */
  filesInFolder (folder: string): ShareEntry[] {
    return this.index.filesInFolder(folder)
  }

  /** Counts announced to the server with SharedFoldersFiles */
  stats (): { folders: number, files: number } {
    return this.index.stats()
  }

  async close (): Promise<void> {
    await this.index.close()
  }
}
