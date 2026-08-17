import type { Readable } from 'stream'
import type { FileAttribute } from '../types'

/** A file shared with the other peers */
export interface ShareEntry {
  /**
   * Path advertised to peers, '\' separated and rooted at the share:
   * 'music\Artist\Album\01 - track.mp3'. Normalized by the index.
   */
  path: string
  /** Size in bytes, may be bigger than 4 GiB */
  size: number
  /**
   * Opaque handle of the file for the provider, given back to `read` and `stat`.
   * Defaults to `path`, use it to keep the real location (fs path, S3 key, row id...)
   * out of what peers see.
   */
  id?: string
  /** Attributes sent along the file, keyed by {@link FileAttribute} */
  attribs?: Partial<Record<FileAttribute, number>>
}

export interface ShareReadOptions {
  /** First byte to send: the offset the downloader asked for, 0 for a fresh transfer */
  start: number
}

/**
 * What `list` may return: an array, an iterable, an async iterable (to stream a paginated
 * listing) or a promise of any of them.
 */
export type ShareListing =
  | Iterable<ShareEntry>
  | AsyncIterable<ShareEntry>
  | Promise<Iterable<ShareEntry> | AsyncIterable<ShareEntry>>

/**
 * Source of shared files. Two operations are needed to serve a share: enumerate it, and read
 * the bytes of one file from a given offset. Anything able to do that can be shared: the local
 * file system, an object store, a database, a remote API.
 */
export interface ShareProvider {
  /** Name used in debug output */
  readonly name?: string
  /**
   * Everything this provider shares. Called on init and on every refresh, so a backend with a
   * paginated listing can yield entries page by page instead of building one big array.
   */
  list: () => ShareListing
  /** Opens the bytes of an entry, starting at `options.start` */
  read: (entry: ShareEntry, options: ShareReadOptions) => Readable | Promise<Readable>
  /** Optional freshness check, called before a transfer starts */
  stat?: (entry: ShareEntry) => Promise<{ size: number } | undefined> | { size: number } | undefined
  /**
   * Optional: answers search requests instead of the built-in matcher, to delegate matching
   * to a database or a search engine. Returned entries must belong to this provider.
   */
  search?: (query: string) => Promise<Iterable<ShareEntry>> | Iterable<ShareEntry>
  /** Optional cleanup, called from `SlskClient.destroy()` */
  close?: () => void | Promise<void>
}

/** Iterates a listing, whatever of the accepted forms it is */
export async function * iterate (listing: ShareListing): AsyncGenerator<ShareEntry> {
  // awaiting a non promise is a no-op, and `for await` accepts sync and async iterables
  for await (const entry of await listing) {
    yield entry
  }
}
