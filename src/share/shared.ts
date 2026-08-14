import EventEmitter from 'events'
import fs from 'fs'
import { dirname, sep as separator } from 'path'
import createDebug from 'debug'
import matches from './matches'
import type { SharedFileEntry } from '../types'

const debug = createDebug('slsk:shared:i')

export interface SharedEvents {
  file: [file: { path: string[], size: number }]
  complete: [folder: string]
}

export default class Shared extends EventEmitter<SharedEvents> {
  files: SharedFileEntry[] = []

  async scanFolder (folder: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.promises.readdir(folder)
    } catch {
      debug(`Folder ${folder} does not exist`)
      return
    }
    for (const entry of entries) {
      await this.scan([folder, entry])
    }
    debug(`Scan folder ${folder} completed, ${this.files.length} shared`)
    this.emit('complete', folder)
  }

  private async scan (path: string[]): Promise<void> {
    const file = path.join(separator)
    const stats = await fs.promises.stat(file)
    if (stats.isFile()) {
      const entry: SharedFileEntry = {
        key: path.slice(Math.max(path.length - 2, 1)).join(separator),
        value: {
          file,
          size: stats.size
        }
      }
      this.files.push(entry)
      this.emit('file', { path, size: stats.size })
    } else {
      const entries = await fs.promises.readdir(file)
      for (const it of entries) {
        await this.scan(path.concat([it]))
      }
    }
  }

  search (query: string): SharedFileEntry[] {
    return this.files.filter(it => matches(it.key, query))
  }

  /** Distinct folders containing at least one shared file */
  folders (): string[] {
    return [...new Set(this.files.map(it => dirname(it.value.file)))]
  }

  /** Shared files of a folder, as requested by a peer browsing our shares */
  filesInFolder (folder: string): SharedFileEntry[] {
    const requested = folder.replace(/[/\\]+$/, '')
    return this.files.filter(it => dirname(it.value.file) === requested)
  }
}
