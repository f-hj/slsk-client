import createDebug from 'debug'
import matches from './matches'
import { iterate, type ShareEntry, type ShareProvider } from './provider'
import { folderOf, normalize } from './virtual-path'

const debug = createDebug('slsk:share:index')

/** An entry and the provider it came from, what is needed to read its bytes back */
export interface IndexedEntry {
  entry: ShareEntry
  provider: ShareProvider
}

/**
 * In memory index of everything the providers share. Providers only produce entries and bytes:
 * normalizing paths, matching search queries, grouping folders and counting is done here, once,
 * for every backend.
 */
export default class ShareIndex {
  private readonly providers: ShareProvider[] = []
  private readonly entriesByProvider = new Map<ShareProvider, ShareEntry[]>()
  private byPath = new Map<string, IndexedEntry>()
  private byLowerPath = new Map<string, IndexedEntry>()

  /** Adds a provider, its files are only listed by the next `refresh()` */
  add (provider: ShareProvider): void {
    if (this.providers.includes(provider)) return
    this.providers.push(provider)
    this.entriesByProvider.set(provider, [])
  }

  /** Replaces the entries of a provider without listing it, used for static shares */
  set (provider: ShareProvider, entries: ShareEntry[]): void {
    this.add(provider)
    this.entriesByProvider.set(provider, entries.map(entry => ({
      ...entry,
      path: normalize(entry.path)
    })))
    this.reindex()
  }

  /** Lists the given provider, or all of them, and rebuilds the index */
  async refresh (provider?: ShareProvider): Promise<void> {
    const targets = provider ? [provider] : [...this.providers]

    for (const target of targets) {
      const entries: ShareEntry[] = []
      try {
        for await (const entry of iterate(target.list())) {
          const path = normalize(entry.path)
          if (path.length === 0) {
            debug(`${target.name ?? 'provider'} returned an entry without path, ignored`)
            continue
          }
          entries.push({ ...entry, path })
        }
      } catch (err) {
        debug(`${target.name ?? 'provider'} listing failed: ${String(err)}`)
        continue
      }
      debug(`${target.name ?? 'provider'} shares ${entries.length} files`)
      this.entriesByProvider.set(target, entries)
    }

    this.reindex()
  }

  /** Rebuilds the lookup maps, the first provider sharing a path wins */
  private reindex (): void {
    this.byPath = new Map()
    this.byLowerPath = new Map()

    for (const provider of this.providers) {
      const entries = this.entriesByProvider.get(provider) ?? []
      for (const entry of entries) {
        if (this.byPath.has(entry.path)) {
          debug(`${entry.path} is shared twice, keeping the first one`)
          continue
        }
        const indexed = { entry, provider }
        this.byPath.set(entry.path, indexed)
        this.byLowerPath.set(entry.path.toLowerCase(), indexed)
      }
    }
  }

  /** Every shared file, in provider order */
  get files (): ShareEntry[] {
    return [...this.byPath.values()].map(indexed => indexed.entry)
  }

  /**
   * Finds a shared file from the path a peer sent back. Only paths this index advertised are
   * resolved: a peer cannot reach anything that is not shared, whatever it asks for.
   */
  resolve (path: string): IndexedEntry | undefined {
    const normalized = normalize(path)
    return this.byPath.get(normalized) ?? this.byLowerPath.get(normalized.toLowerCase())
  }

  /** Files matching a search query, from the providers own search when they implement one */
  async search (query: string): Promise<ShareEntry[]> {
    const results: ShareEntry[] = []

    for (const provider of this.providers) {
      if (!provider.search) {
        const entries = this.entriesByProvider.get(provider) ?? []
        results.push(...entries.filter(entry => matches(entry.path, query)))
        continue
      }

      try {
        for (const entry of await provider.search(query)) {
          // only answer with files this index knows, the path is what the peer will ask for
          const indexed = this.resolve(entry.path)
          if (indexed) results.push(indexed.entry)
        }
      } catch (err) {
        debug(`${provider.name ?? 'provider'} search failed: ${String(err)}`)
      }
    }

    return results
  }

  /** Distinct folders containing at least one shared file */
  folders (): string[] {
    return [...new Set(this.files.map(entry => folderOf(entry.path)))]
  }

  /** Shared files of a folder, as requested by a peer browsing our shares */
  filesInFolder (folder: string): ShareEntry[] {
    const requested = normalize(folder).toLowerCase()
    return this.files.filter(entry => folderOf(entry.path).toLowerCase() === requested)
  }

  /** Counts announced to the server with SharedFoldersFiles */
  stats (): { folders: number, files: number } {
    return {
      folders: this.folders().length,
      files: this.byPath.size
    }
  }

  async close (): Promise<void> {
    for (const provider of this.providers) {
      if (!provider.close) continue
      try {
        await provider.close()
      } catch (err) {
        debug(`${provider.name ?? 'provider'} close failed: ${String(err)}`)
      }
    }
  }
}
