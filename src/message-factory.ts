import crypto from 'crypto'
import zlib from 'zlib'
import Message from './message'
import { extensionOf, folderOf } from './share/virtual-path'
import { FileAttribute } from './types'
import type { ShareEntry } from './share/provider'

export interface FileSearchResultFile {
  user: string
  file: string
  size: number
  attribs: Record<number, number>
}

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

const MessageFactory = {
  to: {
    peer: {
      pierceFw: (token: string): Message => {
        return new Message()
          .int8(0) // code pierceFw
          .rawHexStr(token)
      },
      peerInit: (username: string, type: string, token: string): Message => {
        return new Message()
          .int8(1)
          .str(username)
          .str(type)
          .rawHexStr(token)
      },
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
      /** PlaceInQueueRequest (51) */
      placeInQueueRequest: (file: string): Message => {
        return new Message()
          .int32(51)
          .str(file)
      },
      /** UploadDenied (50) */
      uploadDenied: (file: string, reason: string): Message => {
        return new Message()
          .int32(50)
          .str(file)
          .str(reason)
      }
    },
    server: {
      login: (credentials: { user: string, pass: string }): Message => {
        return new Message()
          .int32(1)
          .str(credentials.user)
          .str(credentials.pass)
          .int32(160)
          .str(crypto.createHash('md5').update(credentials.user + credentials.pass).digest('hex'))
          .int32(17) // ? if someone can explain these fields (taken from nicotine+)
      },
      setWaitPort: (port: number): Message => {
        return new Message()
          .int32(2)
          .int32(port)
      },
      getPeerAddress: (username: string): Message => {
        return new Message()
          .int32(3)
          .str(username)
      },
      addUser: (user: string): Message => {
        return new Message()
          .int32(5)
          .str(user)
      },
      /** ConnectToPeer (18): asks the server to make the peer connect to us */
      connectToPeer: (token: string, username: string, type: string): Message => {
        return new Message()
          .int32(18)
          .rawHexStr(token)
          .str(username)
          .str(type)
      },
      fileSearch: (query: string, token: string): Message => {
        return new Message()
          .int32(26) // code
          .rawHexStr(token) // token as int
          .str(query) // req
      },
      setStatus: (status: number): Message => {
        return new Message()
          .int32(28)
          .int32(status)
      },
      sharedFoldersFiles: (folderCount: number, fileCount: number): Message => {
        return new Message()
          .int32(35)
          .int32(folderCount)
          .int32(fileCount)
      },
      /** HaveNoParent (71), the flag is a single byte boolean */
      haveNoParents: (flag: boolean | number): Message => {
        return new Message()
          .int32(71)
          .int8(flag ? 1 : 0)
      },
      parentIp: (ip: number[]): Message => {
        return new Message()
          .int32(73)
          .int8(ip[0])
          .int8(ip[1])
          .int8(ip[2])
          .int8(ip[3])
      },
      /** BranchLevel (126): our distance to the root of the distributed network */
      branchLevel: (level: number): Message => {
        return new Message()
          .int32(126)
          .int32(level)
      },
      /** BranchRoot (127): user name of the root of our branch */
      branchRoot: (root: string): Message => {
        return new Message()
          .int32(127)
          .str(root)
      },
      /** CantConnectToPeer (1001): tells the server an indirect connection failed */
      cantConnectToPeer: (token: string, username: string): Message => {
        return new Message()
          .int32(1001)
          .rawHexStr(token)
          .str(username)
      }
    }
  },
  from: {
    peer: {
      fileSearchResult: (buffer: Buffer): FileSearchResult => {
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
    }
  }
}

export { FileAttribute }
export default MessageFactory
