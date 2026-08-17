import Message from '../utils/message'

/**
 * Peer init messages: the first message of every connection a peer or we open, whatever the
 * type of the connection (P, D or F). Their code is a single byte, unlike the messages that
 * follow on a peer connection.
 */
const peerMessages = {
  /** PierceFireWall (0): answers a connection the server asked the peer to open */
  pierceFw: (token: string): Message => {
    return new Message()
      .int8(0)
      .rawHexStr(token)
  },
  /** PeerInit (1): introduces us on a connection we opened ourselves */
  peerInit: (username: string, type: string, token: string): Message => {
    return new Message()
      .int8(1)
      .str(username)
      .str(type)
      .rawHexStr(token)
  }
}

export default peerMessages
