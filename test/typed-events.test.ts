/**
 * Compile-time checks that every event emitter exposes typed events.
 * These assertions are verified by `tsc --noEmit` (npm run typecheck / pretest):
 * the positive cases must infer listener payloads, and the `@ts-expect-error`
 * lines fail the type check if an invalid usage ever starts to compile.
 * Nothing here runs any network code: the emitters are never instantiated.
 */

import Server from '../src/server'
import Listen from '../src/listen'
import DefaultPeer from '../src/peer/default-peer'
import DistributedPeer from '../src/peer/distributed-peer'
import Shared from '../src/share/shared'
import Messages from '../src/messages'
import Message from '../src/message'
import { SlskClient } from '../src/index'
import MockServer from './mock-server'
import MockDistributedPeer from './mock-distributed-peer'
import MockDefaultPeer from './mock-default-peer'
import MockUploadPeer from './mock-upload-peer'

// never called, only type checked
export function compileTimeChecks (): void {
  const server = null as unknown as Server
  server.on('connect-to-peer', peer => peer.user.toLowerCase())
  server.on('get-peer-address', peer => peer.host)
  server.on('cant-connect-to-peer', evt => evt.token.toLowerCase())
  server.on('socket-error', err => err.message)
  // @ts-expect-error unknown server event
  server.on('connect-to-pear', () => {})

  const listen = null as unknown as Listen
  listen.on('new-peer', evt => evt.peer.user)
  listen.on('file-transfer', evt => evt.user + evt.token)
  listen.on('pierce-firewall', evt => evt.token.toLowerCase())
  listen.on('socket-error', err => err.message)
  // @ts-expect-error unknown listen event
  listen.on('new-pear', () => {})

  const defaultPeer = null as unknown as DefaultPeer
  defaultPeer.on('disconnect', () => {})
  defaultPeer.on('socket-error', err => err.message)
  // @ts-expect-error a default peer never emits search requests
  defaultPeer.on('search', () => {})

  const distributedPeer = null as unknown as DistributedPeer
  distributedPeer.on('disconnect', () => {})
  distributedPeer.on('search', search => search.query.toLowerCase())
  distributedPeer.on('branch-level', level => level + 1)
  distributedPeer.on('branch-root', root => root.toLowerCase())
  // @ts-expect-error unknown peer event
  distributedPeer.on('shearch', () => {})

  const shared = null as unknown as Shared
  shared.on('complete', folder => folder.toLowerCase())
  shared.on('file', file => file.path.join('/') + file.size)
  // @ts-expect-error complete must be emitted with the folder name
  shared.emit('complete', 42)

  const msgs = null as unknown as Messages
  msgs.on('message', msg => msg.int32())
  msgs.once('message', msg => msg.int32())
  msgs.emit('message', null as unknown as Message)

  const client = null as unknown as SlskClient
  client.on('found', res => res.size + res.speed)
  client.on('found:moby play', res => res.user)
  client.on('download-progress', progress => progress.receivedBytes + (progress.progress ?? 0))
  client.on('download-queue', place => place.user + place.file + place.place)
  client.on('server-error', err => err.message)
  client.on('listen-error', err => err.message)
  client.on('peer-error', (err, user) => err.message + user)
  // @ts-expect-error unknown client event
  client.on('lost', () => {})

  const mockServer = null as unknown as MockServer
  mockServer.on('login', login => login.username)
  mockServer.on('get-peer-address', evt => evt.user)
  mockServer.on('have-no-parent', evt => evt.client)
  // @ts-expect-error unknown mock server event
  mockServer.on('logout', () => {})

  const mockDistributedPeer = null as unknown as MockDistributedPeer
  mockDistributedPeer.on('peer-init', evt => evt.token)
  // @ts-expect-error unknown mock peer event
  mockDistributedPeer.on('peer-init2', () => {})

  const mockDefaultPeer = null as unknown as MockDefaultPeer
  mockDefaultPeer.on('file-search-result', result => result.files.length)
  // @ts-expect-error unknown mock peer event
  mockDefaultPeer.on('file-search-results', () => {})

  const mockUploadPeer = null as unknown as MockUploadPeer
  mockUploadPeer.on('queue-upload', file => file.toLowerCase())
  mockUploadPeer.on('place-in-queue-request', file => file.toLowerCase())
  mockUploadPeer.on('transfer-request', evt => evt.file + evt.token)
  mockUploadPeer.on('transfer-response', evt => evt.token + evt.allowed)
  mockUploadPeer.on('offset', offset => offset + 1)
  // @ts-expect-error unknown mock peer event
  mockUploadPeer.on('upload', () => {})
}

describe('typed event emitters', () => {
  it('compiles with typed listeners (verified by tsc, see @ts-expect-error assertions)', () => {
    // intentionally empty: the checks above are enforced at compile time
  })
})
