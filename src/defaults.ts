import type { ServerAddress } from './types'

/** Where a client connects when nothing else is asked for */
export const DEFAULT_SERVER: ServerAddress = { host: 'server.slsknet.org', port: 2242 }
/** Port incoming peer connections are accepted on by default */
export const DEFAULT_INCOMING_PORT = 2234
/** ms before the login attempt fails */
export const DEFAULT_LOGIN_TIMEOUT = 10000
/** ms to wait for a peer connection, direct or relayed by the server */
export const PEER_TIMEOUT = 10000
/** ms before accepting a transfer a peer announced, some peers need a beat */
export const TRANSFER_ACCEPT_DELAY = 200
/** ms a peer is given to answer a UserInfoRequest */
export const USER_INFO_TIMEOUT = 10000
/** How many times a transfer that stopped early is asked for again */
export const DOWNLOAD_RETRIES = 3
/** ms before asking a peer for the rest of an interrupted transfer */
export const RESUME_DELAY = 1000
/** ms of silence on a file connection before the transfer is considered dead */
export const DEFAULT_TRANSFER_TIMEOUT = 10 * 60 * 1000
/** How many files are sent at the same time when nothing else is asked for */
export const DEFAULT_UPLOAD_SLOTS = 1
/** How many files one peer may keep waiting in our queue */
export const DEFAULT_QUEUE_LIMIT = 100
/** How many distributed search requests are remembered to drop the duplicates */
export const MAX_SEEN_SEARCHES = 5000
/** ms to wait for any sign that a peer understands the upload queue before asking the old way */
export const DEFAULT_QUEUE_FALLBACK_DELAY = 10000
/** ms before the first attempt at reconnecting to the slsk server */
export const DEFAULT_RECONNECT_DELAY = 1000
/** Longest ms between two reconnection attempts, the delay doubles until it */
export const DEFAULT_MAX_RECONNECT_DELAY = 60000
