import crypto from 'crypto'
import createDebug from 'debug'
import DefaultPeer from '../peer/default-peer/default-peer'
import { MAX_SEEN_SEARCHES } from '../defaults'
import type { ClientContext } from '../context'
import type {
  FileSearchResult,
  FileSearchResultFile,
  FileSearchResultOptions
} from '../peer/default-peer/messages'
import type { SearchOptions, SearchResult } from '../types'

const debug = createDebug('slsk:search')

interface PendingSearch {
  query: string
  onResult: (res: SearchResult) => void
}

/** The searches this client sent and is collecting answers for, and the ones it answers itself */
export default class Searching {
  /** Searches waiting for results, by token */
  private readonly pending = new Map<string, PendingSearch>()
  /** Distributed search requests already answered, the same one reaches us from every parent */
  private readonly seen = new Set<string>()

  constructor (private readonly ctx: ClientContext) {}

  /**
   * Searches for files. Slsk doesn't tell when a search is finished, so results are
   * collected until the timeout is reached and then returned all at once.
   * Individual results are also emitted as 'found' and 'found:{req}' events.
   */
  async search (obj: SearchOptions): Promise<SearchResult[]> {
    const token = crypto.randomBytes(4).toString('hex')
    const timeout = obj.timeout || 4000
    const results: SearchResult[] = []

    this.pending.set(token, {
      query: obj.req,
      onResult: res => {
        this.ctx.emit('found', res)
        this.ctx.emit(`found:${obj.req}`, res)
        results.push(res)
      }
    })

    try {
      this.ctx.server.fileSearch(obj.req, token)
      await new Promise<void>(resolve => setTimeout(resolve, timeout))
      return results
    } finally {
      this.pending.delete(token)
    }
  }

  /** Files a peer sent back for one of our searches */
  onResult (result: FileSearchResult): void {
    const search = this.pending.get(result.currentToken)
    if (!search) {
      // a search that already returned, or a token we never asked for
      debug(`dropping ${result.files.length} results of the unknown search ${result.currentToken}`)
      return
    }

    result.files.forEach(file => {
      search.onResult(toSearchResult(file, result))
    })
  }

  /** Answers a search request received from the distributed network with our shares */
  async answerRequest (user: string, ticket: string, query: string): Promise<void> {
    if (!this.remember(`${user}_${ticket}_${query}`)) return

    const matched = await this.ctx.sharing.shared.search(query)
    if (matched.length === 0) return

    debug(`Search from peer ${user}, query: ${query}. Matched: ${matched.length} files`)

    const existing = this.ctx.peers.peerConnection(user)
    if (existing) {
      existing.fileSearchResult(matched, ticket, this.ctx.session.username)
      return
    }

    /*
     * Most searchers cannot accept a connection: they are behind a router that forwards
     * nothing. Asking the server for their address and connecting to it only works for the
     * few that are reachable, so the answer goes through connectToUser, which also asks the
     * server to make the peer connect to us.
     */
    const connection = await this.ctx.peers.connectToUser(user)
    if (!(connection instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }
    connection.fileSearchResult(matched, ticket, this.ctx.session.username, this.answerState())
  }

  /**
   * Slots and queue length sent with a search answer: what a searcher uses to pick the source it
   * asks first, so a client with nothing free must not claim a free slot.
   */
  private answerState (): FileSearchResultOptions {
    const capacity = this.ctx.serving.capacity()
    return { slotsFree: capacity.slotsFree, queueLength: capacity.queueSize }
  }

  /** false when this exact search request was already answered */
  private remember (key: string): boolean {
    if (this.seen.has(key)) return false

    this.seen.add(key)
    if (this.seen.size > MAX_SEEN_SEARCHES) {
      // a Set keeps the insertion order, the first key is the oldest one
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return true
  }

  /** Forgets the searches still collecting results, which will never return now */
  clear (): void {
    this.pending.clear()
  }
}

/** Turns a file of a FileSearchResult into what the search API exposes */
export function toSearchResult (file: FileSearchResultFile, result: FileSearchResult): SearchResult {
  return {
    user: file.user,
    file: file.file,
    size: file.size,
    slots: result.slots >= 1,
    // as they came: what a peer sends about a file is its own business, including unknown codes
    attribs: file.attribs,
    speed: result.speed,
    queueLength: result.queueLength
  }
}
