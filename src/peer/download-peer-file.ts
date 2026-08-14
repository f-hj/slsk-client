import net from 'net'
import fs from 'fs'
import createDebug from 'debug'
import MessageFactory from '../message-factory'
import stack, { downloadKey, failDownload, type DownloadToken, type PendingDownload } from '../stack'

const debug = createDebug('slsk:peer:file')

export interface FileTransferOptions {
  /** Peer sending the file */
  user: string
  /** Transfer token, when we already know it (we initiated the connection) */
  token?: string
  /**
   * true when the uploader announces the transfer with its 4 bytes token,
   * which must be read before we answer with the file offset
   */
  readToken?: boolean
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
  /** ms to wait before sending the offset, used by the legacy PeerInit flow */
  offsetDelay?: number
}

/**
 * Handles the download side of a file connection (type F): reads the transfer token when the
 * uploader sends it, answers with the file offset (non zero to resume) and collects the data
 * until the announced size is reached.
 */
export function attachFileTransfer (conn: net.Socket, options: FileTransferOptions): void {
  const user = options.user
  let token = options.token
  let tok: DownloadToken | undefined
  let down: PendingDownload | undefined
  let offset = 0
  let buf = Buffer.alloc(0)
  let tokenRead = options.readToken !== true
  let offsetSent = false
  let dataEvents = 0

  const resolvePending = (): void => {
    if (tok || !token) return
    const pending = stack.downloadTokens[token]
    if (!pending) return
    tok = pending
    down = stack.download[downloadKey(pending.user, pending.file)]
    offset = down?.offset ?? 0
  }

  const sendOffset = (): void => {
    if (offsetSent) return
    if (conn.destroyed) {
      debug('socket closed before the offset could be sent')
      return
    }
    offsetSent = true
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(offset), 0)
    debug(`send file offset ${offset} to ${user}`)
    conn.write(b)
  }

  const onFileData = (data: Buffer): void => {
    if (data.length === 0) return
    resolvePending()

    if (down?.stream) down.stream.push(data)
    buf = Buffer.concat([buf, data])

    const received = offset + buf.length
    if (down?.onProgress) down.onProgress(received, tok?.size)
    if (dataEvents++ % 10 === 0) {
      debug(`received: ${received} size: ${tok?.size ?? 'unknown'}`)
    }

    if (tok?.size !== undefined && received >= tok.size) {
      debug(`disconnect, received: ${received} size: ${tok.size}`)
      conn.end()
    }
  }

  const onData = (data: Buffer): void => {
    if (!tokenRead) {
      if (data.length < 4) {
        // extremely unlikely, but the token can be split over two chunks
        buf = Buffer.concat([buf, data])
        if (buf.length < 4) return
        data = buf
        buf = Buffer.alloc(0)
      }
      token = data.toString('hex', 0, 4)
      tokenRead = true
      debug(`recv transfer token ${token} from ${user}`)
      resolvePending()
      sendOffset()
      onFileData(data.subarray(4))
      return
    }

    onFileData(data)
  }

  resolvePending()
  conn.on('data', onData)

  if (options.initialData && options.initialData.length > 0) {
    onData(options.initialData)
  }

  if (options.readToken !== true) {
    if (options.offsetDelay) {
      setTimeout(sendOffset, options.offsetDelay)
    } else {
      sendOffset()
    }
  }

  conn.on('close', () => {
    debug(`file socket close ${user}`)
    const currentTok = tok
    const currentDown = down
    if (currentTok && currentDown) {
      delete stack.download[downloadKey(currentTok.user, currentTok.file)]
      if (currentDown.stream) currentDown.stream.push(null)
      const filePath = currentDown.path || getFilePathName(currentTok.user, currentTok.file)
      const write = offset > 0
        ? fs.promises.appendFile(filePath, buf)
        : fs.promises.writeFile(filePath, buf)
      write
        .then(() => {
          if (currentDown.resolve) {
            currentDown.resolve({
              path: filePath,
              buffer: buf,
              stream: currentDown.stream,
              receivedBytes: offset + buf.length,
              size: currentTok.size
            })
          }
        })
        .catch(err => {
          if (currentDown.reject) currentDown.reject(err)
        })
    } else {
      fs.promises.writeFile(`${user}-${token ?? 'unknown'}.mp3`, buf).catch(() => {})
      debug(`ERROR: token ${token ?? 'unknown'} not exist`)
    }
  })

  conn.on('error', () => {
    debug(`file socket error ${user}, destroying`)
    conn.destroy()
    // close event will be called (https://nodejs.org/api/net.html#net_event_error_1)
  })
}

/** Opens a file connection (type F) to a peer to download a file */
export default function downloadPeerFile (host: string, port: number, token: string, user: string, noPierce: boolean): void {
  debug(`downloadPeerFile ${user}`)
  const conn = net.createConnection({ host, port })
  let connected = false

  conn.once('connect', () => {
    connected = true
    if (noPierce) {
      debug(`noPierce ${user} connected`)
      conn.write(MessageFactory
        .to.peer
        .peerInit(stack.currentLogin as string, 'F', token)
        .getBuff())
    } else {
      conn.write(MessageFactory
        .to.peer
        .pierceFw(token)
        .getBuff())
    }

    attachFileTransfer(conn, {
      user,
      token,
      // when we initiate with PeerInit the uploader does not send its token back,
      // the legacy flow expects the offset shortly after the init message
      readToken: !noPierce,
      offsetDelay: noPierce ? 1000 : undefined
    })
  })

  conn.on('error', () => {
    debug(`file socket error ${user}, destroying`)
    conn.destroy()
  })

  conn.on('close', () => {
    if (connected) return // the transfer handler takes care of the pending download
    const pending = stack.downloadTokens[token]
    debug(`file socket closed before connect ${user}`)
    if (pending) {
      failDownload(pending.user, pending.file, new Error(`Cannot connect to ${user}`))
    }
  })
}

function getFilePathName (user: string, file: string): string {
  const parts = file.split('\\')
  return `/tmp/slsk/${user}_${parts[parts.length - 1]}`
}
