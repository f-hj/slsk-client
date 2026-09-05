import { Readable } from 'stream'
import { normalize } from '../virtual-path'
import type { ShareEntry, ShareProvider, ShareReadOptions } from '../provider'
import type { FileAttributes } from '../../types'

export interface MemoryShareFile {
  /** Path advertised to peers */
  path: string
  /** Content of the file */
  data: Buffer | string
  /** Attributes sent along the file, keyed by {@link FileAttribute} */
  attribs?: FileAttributes
}

/**
 * Shares files held in memory, handy for tests and for small shares generated on the fly.
 * Accepts a list of files or a path → content map.
 */
export default function memoryShareProvider (
  files: MemoryShareFile[] | Record<string, Buffer | string>
): ShareProvider {
  const list: MemoryShareFile[] = Array.isArray(files)
    ? files
    : Object.keys(files).map(path => ({ path, data: files[path] }))

  const contents = new Map<string, Buffer>()
  const entries: ShareEntry[] = list.map(file => {
    const path = normalize(file.path)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    contents.set(path, data)
    return {
      path,
      size: data.length,
      attribs: file.attribs
    }
  })

  return {
    name: 'memory',
    list: () => entries,
    stat: (entry: ShareEntry) => {
      const data = contents.get(entry.path)
      return data ? { size: data.length } : undefined
    },
    read: (entry: ShareEntry, options: ShareReadOptions) => {
      const data = contents.get(entry.path)
      if (!data) throw new Error(`${entry.path} is not shared`)
      return Readable.from(data.subarray(options.start))
    }
  }
}
