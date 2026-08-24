import net from 'net'
import { PEER_TIMEOUT } from '../defaults'

/**
 * Opens a connection to a peer, giving up after `timeout` instead of waiting for the system to
 * declare the address unreachable, which takes over two minutes: a peer that accepted a transfer
 * gives up long before that, so the relayed route has to be tried while it is still waiting.
 *
 * The timer is its own, not `socket.setTimeout`, which a file connection sets to the idle timeout
 * of the transfer as soon as it is up.
 */
export default function dial (host: string, port: number, timeout = PEER_TIMEOUT): net.Socket {
  const socket = net.createConnection({ host, port })

  const gaveUp = setTimeout(() => {
    socket.destroy(new Error(`Connection to ${host}:${port} timed out`))
  }, timeout)
  // a dial nobody is waiting for must not keep the process alive
  gaveUp.unref()

  socket.once('connect', () => clearTimeout(gaveUp))
  socket.once('close', () => clearTimeout(gaveUp))

  return socket
}
