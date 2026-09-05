import fs from 'fs'
import { basename, join } from 'path'
import { Readable } from 'stream'
import createDebug from 'debug'
import { SEPARATOR } from '../virtual-path'
import type { ShareEntry, ShareProvider, ShareReadOptions } from '../provider'

const debug = createDebug('slsk:share:fs')

/** Stats of an entry, the subset used to walk a share */
export interface FsLikeStats {
  size: number
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink?: () => boolean
}

/** Open file, the subset used to read the bytes of a shared file */
export interface FsLikeFileHandle {
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
  createReadStream?: (options: { start?: number }) => Readable
}

/**
 * `fs.promises` compatible implementation. Anything with these four methods works:
 * `fs.promises` itself, memfs, unionfs, a `node:vfs` VirtualFileSystem `promises` namespace...
 */
export interface FsLike {
  readdir: (path: string) => Promise<string[]>
  stat: (path: string) => Promise<FsLikeStats>
  lstat?: (path: string) => Promise<FsLikeStats>
  open: (path: string, flags?: string) => Promise<FsLikeFileHandle>
}

export interface FsShareProviderOptions {
  /** Folders to share */
  folders: string[]
  /**
   * Name of the virtual root of each folder, what peers see before the first separator.
   * Defaults to the base name of the folder, so '/home/me/music' is shared as 'music\...'
   */
  root?: string | ((folder: string) => string)
  /** Implementation to read from (default: `fs.promises` of this process) */
  fs?: FsLike
  /** Follow symbolic links while scanning (default: true, as long as `maxDepth` allows) */
  followSymlinks?: boolean
  /**
   * Share the files and folders whose name starts with a dot (default: false). Peers have no
   * use for `.DS_Store`, `.git` or `.cache`, and they would be advertised as any other file.
   */
  includeHidden?: boolean
  /** Maximum folder depth, guards against symlink loops (default: 32) */
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 32
const CHUNK_SIZE = 64 * 1024

/** Shares folders of a file system, the local one by default */
export default function fsShareProvider (options: FsShareProviderOptions): ShareProvider {
  // fs.promises has everything FsLike asks for, the cast only drops the methods we ignore
  const files: FsLike = options.fs ?? (fs.promises as unknown as FsLike)
  const custom = options.fs !== undefined
  const followSymlinks = options.followSymlinks !== false
  const includeHidden = options.includeHidden === true
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH

  const rootOf = (folder: string): string => {
    if (typeof options.root === 'function') return options.root(folder)
    if (typeof options.root === 'string') return options.root
    return basename(folder) || folder
  }

  async function statOf (path: string): Promise<FsLikeStats | undefined> {
    try {
      // lstat first so a symlink can be recognized before it is followed
      return followSymlinks || !files.lstat ? await files.stat(path) : await files.lstat(path)
    } catch (err) {
      debug(`cannot stat ${path}: ${String(err)}`)
      return undefined
    }
  }

  async function * scan (folder: string, virtual: string, depth: number): AsyncGenerator<ShareEntry> {
    if (depth > maxDepth) {
      debug(`max depth reached in ${folder}`)
      return
    }

    let entries: string[]
    try {
      entries = await files.readdir(folder)
    } catch (err) {
      debug(`cannot read folder ${folder}: ${String(err)}`)
      return
    }

    for (const name of entries.sort()) {
      if (!includeHidden && name.startsWith('.')) continue
      const path = join(folder, name)
      const stats = await statOf(path)
      if (!stats) continue

      if (stats.isDirectory()) {
        yield * scan(path, virtual + SEPARATOR + name, depth + 1)
      } else if (stats.isFile()) {
        yield {
          path: virtual + SEPARATOR + name,
          size: stats.size,
          id: path
        }
      }
    }
  }

  return {
    name: custom ? 'fs (custom)' : 'fs',
    list: async function * () {
      for (const folder of options.folders) {
        yield * scan(folder, rootOf(folder), 1)
      }
    },
    stat: async (entry: ShareEntry) => {
      const stats = await statOf(entry.id ?? entry.path)
      return stats?.isFile() ? { size: stats.size } : undefined
    },
    read: async (entry: ShareEntry, readOptions: ShareReadOptions) => {
      const path = entry.id ?? entry.path
      if (!custom) return fs.createReadStream(path, { start: readOptions.start })

      const handle = await files.open(path, 'r')
      if (handle.createReadStream) {
        return handle.createReadStream({ start: readOptions.start })
      }
      return handleStream(handle, readOptions.start)
    }
  }
}

/** Reads an open file by chunks, for implementations without createReadStream */
function handleStream (handle: FsLikeFileHandle, start: number): Readable {
  let position = start
  let open = true

  const closeHandle = async (): Promise<void> => {
    if (!open) return
    open = false
    await handle.close().catch(err => debug(`cannot close file: ${String(err)}`))
  }

  return new Readable({
    read (size: number) {
      const length = Math.min(Math.max(size, 1), CHUNK_SIZE)
      const buffer = Buffer.alloc(length)
      handle.read(buffer, 0, length, position)
        .then(async ({ bytesRead }) => {
          if (bytesRead === 0) {
            await closeHandle()
            this.push(null)
            return
          }
          position += bytesRead
          this.push(buffer.subarray(0, bytesRead))
        })
        .catch((err: Error) => {
          this.destroy(err)
        })
    },
    destroy (err, callback) {
      closeHandle().then(() => callback(err)).catch(() => callback(err))
    }
  })
}
