import zlib from 'zlib'
import Message from '../../utils/message'
import { extensionOf, folderOf } from '../../share/virtual-path'
import type { FileAttribute } from '../../types'
import type { ShareEntry } from '../../share/provider'

/** A file of a search answer, as a peer sent it */
export interface FileSearchResultFile {
  user: string
  file: string
  size: number
  attribs: Record<number, number>
}

/** Search answer of a peer, once decompressed and parsed */
export interface FileSearchResult {
  currentToken: string
  files: FileSearchResultFile[]
  slots: number
  speed: number
  /** Number of files queued for upload on the peer side */
  queueLength: number
}

export interface FileSearchResultOptions {
  /** true when a slot is free to upload immediately (default: true) */
  slotsFree?: boolean
  /** Average upload speed advertised to the peer (default: 0) */
  avgSpeed?: number
  /** Number of files currently queued for upload (default: 0) */
  queueLength?: number
}

export interface UserInfoOptions {
  description?: string
  uploadSlots?: number
  queueSize?: number
  slotsFree?: boolean
}

/** A transfer a peer asked for, in one direction or the other */
export interface TransferRequestEvent {
  /** 0 when the peer wants to download from us, 1 when it announces an upload to us */
  direction: number
  token: string
  file: string
  /** Only sent with direction 1 */
  size?: number
}

/** What a peer answered to a transfer we asked for */
export interface TransferResponseEvent {
  token: string
  allowed: boolean
  /** Only sent when the transfer is refused */
  reason?: string
}

/** Groups shared files by folder, as expected by the SharedFileList/FolderContents messages */
function byFolder (files: ShareEntry[]): Map<string, ShareEntry[]> {
  const folders = new Map<string, ShareEntry[]>()
  files.forEach(file => {
    const folder = folderOf(file.path)
    const entries = folders.get(folder)
    if (entries) {
      entries.push(file)
    } else {
      folders.set(folder, [file])
    }
  })
  return folders
}

/** Writes a single file entry (code 1, name, size, extension, attributes) */
function writeFile (msg: Message, file: ShareEntry): void {
  const attribs = file.attribs
    ? Object.keys(file.attribs)
      .map(Number)
      .filter(code => typeof file.attribs?.[code as FileAttribute] === 'number')
      .sort((a, b) => a - b)
    : []

  msg.int8(1) // code, always 1 for a file
  msg.str(file.path)
  msg.int64(file.size)
  msg.str(extensionOf(file.path))
  msg.int32(attribs.length)
  attribs.forEach(code => {
    msg.int32(code)
    msg.int32(file.attribs?.[code as FileAttribute] as number)
  })
}

/** Writes the folder → files structure shared by SharedFileList and FolderContents */
function writeFolders (msg: Message, folders: Map<string, ShareEntry[]>): void {
  msg.int32(folders.size)
  folders.forEach((entries, folder) => {
    msg.str(folder)
    msg.int32(entries.length)
    entries.forEach(file => writeFile(msg, file))
  })
}

/** Messages exchanged on a peer connection (type P), their code is an uint32 */
const defaultPeerMessages = {
  /** SharedFileListResponse (5): the whole payload is zlib compressed */
  sharedFileList: (files: ShareEntry[]): Message => {
    const msg = new Message()
    writeFolders(msg, byFolder(files))
    msg.int32(0) // unknown
    msg.int32(0) // number of private folders

    return new Message()
      .int32(5)
      .writeBuffer(zlib.deflateSync(msg.data))
  },
  /** FolderContentsResponse (37): the whole payload, token included, is zlib compressed */
  folderContentsResponse: (token: string, folder: string, files: ShareEntry[]): Message => {
    const msg = new Message()
      .rawHexStr(token)
      .int32(1) // number of requested folders in this response
      .str(folder)

    writeFolders(msg, byFolder(files))

    return new Message()
      .int32(37)
      .writeBuffer(zlib.deflateSync(msg.data))
  },
  /** FileSearchResponse (9): our matches for a search, zlib compressed */
  fileSearchResult: (
    files: ShareEntry[],
    token: string,
    user: string,
    options: FileSearchResultOptions = {}
  ): Message => {
    const msg = new Message()
      .str(user)
      .rawHexStr(token)
      .int32(files.length)

    files.forEach(file => writeFile(msg, file))

    msg.int8(options.slotsFree === false ? 0 : 1) // free upload slot
    msg.int32(options.avgSpeed ?? 0)
    msg.int32(options.queueLength ?? 0)
    msg.int32(0) // unknown
    msg.int32(0) // number of private results

    return new Message()
      .int32(9)
      .writeBuffer(zlib.deflateSync(msg.data))
  },
  /** UserInfoResponse (16) */
  userInfoResponse: (options: UserInfoOptions = {}): Message => {
    return new Message()
      .int32(16)
      .str(options.description ?? '')
      .int8(0) // no picture
      .int32(options.uploadSlots ?? 0)
      .int32(options.queueSize ?? 0)
      .int8(options.slotsFree === true ? 1 : 0)
  },
  /**
   * TransferRequest (40) with direction 0: the legacy way of asking for a download.
   * Modern clients send QueueUpload (43) instead.
   */
  transferRequest: (file: string, token: string): Message => {
    return new Message()
      .int32(40) // code
      .int32(0) // direction
      .rawHexStr(token) // token
      .str(file)
  },
  /** TransferResponse (41), answered to a TransferRequest received from a peer */
  transferResponse: (token: string, allowed = true, reason?: string): Message => {
    const msg = new Message()
      .int32(41)
      .rawHexStr(token)
      .int8(allowed ? 1 : 0)

    if (!allowed) msg.str(reason ?? 'Cancelled')

    return msg
  },
  /** QueueUpload (43): asks the peer to queue a file for upload to us */
  queueUpload: (file: string): Message => {
    return new Message()
      .int32(43)
      .str(file)
  },
  /** UploadDenied (50) */
  uploadDenied: (file: string, reason: string): Message => {
    return new Message()
      .int32(50)
      .str(file)
      .str(reason)
  },
  /** PlaceInQueueRequest (51) */
  placeInQueueRequest: (file: string): Message => {
    return new Message()
      .int32(51)
      .str(file)
  }
}

/** Reads the decompressed payload of a FileSearchResponse (9) */
export function parseFileSearchResult (buffer: Buffer): FileSearchResult {
  const msg = new Message(buffer)
  const user = msg.str()
  const currentToken = msg.rawHexStr(4)
  const nbFiles = msg.int32()
  const files: FileSearchResultFile[] = []
  for (let i = 0; i < nbFiles; i++) {
    msg.int8() // code
    const filename = msg.str()
    const filesize = msg.int64()
    msg.str() // ext
    const nbAttrib = msg.int32()
    const attribs: Record<number, number> = {}
    for (let attrib = 0; attrib < nbAttrib; attrib++) {
      attribs[msg.int32()] = msg.int32()
    }

    files.push({
      user,
      file: filename,
      size: filesize,
      attribs
    })
  }
  // older peers stop right after the file list
  const slots = msg.remaining() >= 1 ? msg.int8() : 0
  const speed = msg.remaining() >= 4 ? msg.int32() : 0
  const queueLength = msg.remaining() >= 4 ? msg.int32() : 0

  return {
    currentToken,
    files,
    slots,
    speed,
    queueLength
  }
}

export default defaultPeerMessages
