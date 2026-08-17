import crypto from 'crypto'
import Message from '../utils/message'

/** Messages sent to the slsk server, their code is an uint32 */
const serverMessages = {
  /** Login (1) */
  login: (credentials: { user: string, pass: string }): Message => {
    return new Message()
      .int32(1)
      .str(credentials.user)
      .str(credentials.pass)
      .int32(160)
      .str(crypto.createHash('md5').update(credentials.user + credentials.pass).digest('hex'))
      .int32(17) // ? if someone can explain these fields (taken from nicotine+)
  },
  /** SetWaitPort (2): the port we accept incoming peer connections on */
  setWaitPort: (port: number): Message => {
    return new Message()
      .int32(2)
      .int32(port)
  },
  /** GetPeerAddress (3) */
  getPeerAddress: (username: string): Message => {
    return new Message()
      .int32(3)
      .str(username)
  },
  /** WatchUser (5) */
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
  /** FileSearch (26) */
  fileSearch: (query: string, token: string): Message => {
    return new Message()
      .int32(26) // code
      .rawHexStr(token) // token as int
      .str(query) // req
  },
  /** SetStatus (28): 1 away, 2 online */
  setStatus: (status: number): Message => {
    return new Message()
      .int32(28)
      .int32(status)
  },
  /** SharedFoldersFiles (35): how much we share */
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
  /** ParentIP (73), deprecated but still accepted */
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

export default serverMessages
