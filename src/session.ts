import Downloads from './download/downloads'

/**
 * State of one client that the peer connections and the file transfers need to see. Passed
 * explicitly to whoever needs it, so several clients can live in the same process without
 * stepping on each other.
 */
export default class Session {
  /** Name this client logs in as, empty until the login is sent */
  username = ''
  readonly downloads = new Downloads()
}
