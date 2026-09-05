import zlib from 'zlib'
import Message from '../../utils/message'
import { baseNameOf, extensionOf, folderOf } from '../../share/virtual-path'
import { UploadPermission } from '../../types'
import type { FileAttribute, FileAttributes, UserInfo, UserInfoOptions } from '../../types'
import type { ShareEntry } from '../../share/provider'

/** A file of a search answer, as a peer sent it */
export interface FileSearchResultFile {
  user: string
  file: string
  size: number
  /** Everything the peer said about the file, keyed by {@link FileAttribute} */
  attribs: FileAttributes
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

export type { UserInfoOptions }

/** Answered to a peer asking for our info when nothing else was configured */
export const DEFAULT_USER_INFO: UserInfoOptions = {
  description: '',
  uploadSlots: 1,
  queueSize: 0,
  slotsFree: true,
  uploadPermitted: UploadPermission.Everyone
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

/**
 * Writes a single file entry (code 1, name, size, extension, attributes).
 * `name` is the whole virtual path in a search answer, but only the base name in a folder
 * listing, where the folder it belongs to is written next to it.
 */
function writeFile (msg: Message, file: ShareEntry, name: string): void {
  const attribs = file.attribs
    ? Object.keys(file.attribs)
      .map(Number)
      .filter(code => typeof file.attribs?.[code as FileAttribute] === 'number')
      .sort((a, b) => a - b)
    : []

  msg.int8(1) // code, always 1 for a file
  msg.str(name)
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
    // the folder is on the line above, a browsing peer expects the base name here
    entries.forEach(file => writeFile(msg, file, baseNameOf(file.path)))
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

    // a search answer has no folder to root the files in, they carry their whole path
    files.forEach(file => writeFile(msg, file, file.path))

    msg.int8(options.slotsFree === false ? 0 : 1) // free upload slot
    msg.int32(options.avgSpeed ?? 0)
    msg.int32(options.queueLength ?? 0)
    msg.int32(0) // unknown
    msg.int32(0) // number of private results

    return new Message()
      .int32(9)
      .writeBuffer(zlib.deflateSync(msg.data))
  },
  /** UserInfoRequest (15): asks a peer what it tells about itself */
  userInfoRequest: (): Message => {
    return new Message().int32(15)
  },
  /** UserInfoResponse (16), the fields left out filled with {@link DEFAULT_USER_INFO} */
  userInfoResponse: (options: UserInfoOptions = {}): Message => {
    const info = { ...DEFAULT_USER_INFO, ...options }

    const msg = new Message()
      .int32(16)
      .str(info.description ?? '')

    if (info.picture && info.picture.length > 0) {
      msg.int8(1)
      // a picture is sent as its length followed by its bytes
      msg.int32(info.picture.length)
      msg.writeBuffer(info.picture)
    } else {
      msg.int8(0)
    }

    msg.int32(info.uploadSlots ?? 0)
    msg.int32(info.queueSize ?? 0)
    msg.int8(info.slotsFree === true ? 1 : 0)

    // trailing field, left out when it is explicitly unset
    if (info.uploadPermitted !== undefined) msg.int32(info.uploadPermitted)

    return msg
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
  /**
   * TransferRequest (40) with direction 1: announces a file we are about to send, which is how
   * an upload starts once a slot is free. The peer answers with a TransferResponse (41).
   */
  uploadRequest: (file: string, token: string, size: number): Message => {
    return new Message()
      .int32(40) // code
      .int32(1) // direction, 1 for a file we send
      .rawHexStr(token)
      .str(file)
      .int64(size)
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
  /** PlaceInQueueResponse (44): tells a peer where its file stands in our queue */
  placeInQueueResponse: (file: string, place: number): Message => {
    return new Message()
      .int32(44)
      .str(file)
      .int32(place)
  },
  /** UploadFailed (46): tells a peer the transfer we announced will not happen after all */
  uploadFailed: (file: string): Message => {
    return new Message()
      .int32(46)
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
    msg.str() // ext, obsolete and ignored by current clients
    const nbAttrib = msg.int32()
    const attribs: FileAttributes = {}
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

/**
 * Reads a UserInfoResponse (16), the message pointer sitting right after its code.
 * Peers stop at different fields, so everything after the description is optional.
 */
export function parseUserInfo (msg: Message, user: string): UserInfo {
  const description = msg.str()

  let picture: Buffer | undefined
  if (msg.remaining() >= 1 && msg.int8() === 1 && msg.remaining() >= 4) {
    const length = msg.int32()
    const bytes = msg.readBuffer(length)
    // a peer announcing a picture it then truncates is not one to trust the size of
    if (bytes.length === length && length > 0) picture = bytes
  }

  const uploadSlots = msg.remaining() >= 4 ? msg.int32() : 0
  const queueSize = msg.remaining() >= 4 ? msg.int32() : 0
  const slotsFree = msg.remaining() >= 1 ? msg.int8() === 1 : false
  const uploadPermitted = msg.remaining() >= 4
    ? msg.int32() as UploadPermission
    : undefined

  return {
    user,
    description,
    picture,
    uploadSlots,
    queueSize,
    slotsFree,
    uploadPermitted
  }
}

export default defaultPeerMessages
