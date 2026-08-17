import type { Readable } from 'stream'
import type { Download, SearchResult } from './types'
import type { ShareEntry } from './share/provider'

export interface PendingSearch {
  cb: (res: SearchResult) => void
  query: string
}

export interface PendingDownload {
  resolve?: (down: Download) => void
  reject?: (err: Error) => void
  path?: string
  stream?: Readable
  /** Bytes already downloaded, sent as the file offset to resume a partial transfer */
  offset?: number
  /** Set by the client to report the transfer progress */
  onProgress?: (receivedBytes: number, totalBytes?: number) => void
  /** Set by the client to report the place in the upload queue of the peer */
  onQueue?: (place: number) => void
}

export interface DownloadToken {
  user: string
  file: string
  size?: number
}

export interface Stack {
  /** Internal login continuation, deleted once the server answered or the login timed out */
  login?: (err?: Error) => void
  /** Username of the currently logged-in user */
  currentLogin?: string
  search: Record<string, PendingSearch>
  download: Record<string, PendingDownload>
  downloadTokens: Record<string, DownloadToken>
  peerSearchMatches: Record<string, Record<string, ShareEntry[]>>
  peerSearchRequests: string[]
}

const stack: Stack = {
  search: {},
  download: {},
  downloadTokens: {},
  peerSearchMatches: {},
  peerSearchRequests: []
}

/** Key used to store a pending download */
export function downloadKey (user: string, file: string): string {
  return user + '_' + file
}

/**
 * Fails a pending download and forgets it, so a peer cannot settle it twice.
 * Returns false when no download was pending for this user/file.
 */
export function failDownload (user: string, file: string, err: Error): boolean {
  const key = downloadKey(user, file)
  const down = stack.download[key]
  if (!down) return false

  delete stack.download[key]
  Object.keys(stack.downloadTokens).forEach(token => {
    const pending = stack.downloadTokens[token]
    if (pending.user === user && pending.file === file) {
      delete stack.downloadTokens[token]
    }
  })

  if (down.stream) down.stream.destroy(err)
  if (down.reject) down.reject(err)
  return true
}

export default stack
