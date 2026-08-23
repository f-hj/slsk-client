# Soulseek Protocol Compliance Report

Reference: [nicotine-plus SLSKPROTOCOL.html](https://nicotine-plus.org/doc/SLSKPROTOCOL.html) (checked 2026-08-12).

Legend for the *Status* column:

- ✅ **Compliant** — wire format matches the documentation
- 🟡 **Partial** — works in practice, but deviates from the documented layout or only reads/writes a subset
- 🟠 **Log only** — message is parsed (fully or partly) but only debug-logged, no behavior
- ❌ **Missing** — not implemented at all
- ⚪ **N/A** — obsolete/deprecated in the protocol, intentionally not implemented

All messages are framed as `uint32 length (LE) + payload` and re-assembled by [`Messages`](../src/utils/messages.ts), including partial TCP chunks — compliant with the documented framing.

---

## 1. Server messages (connection to server.slsknet.org:2242)

Implemented in [`src/server/`](../src/server/) (receive + send helpers) and [`src/server/messages.ts`](../src/server/messages.ts) (encoding). Code field: `uint32`.

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 1 | Login (send) | user, pass, uint32 major, md5(user+pass), uint32 minor | Sends `user, pass, 160, md5, 17` | ✅ |
| 1 | Login (recv) | bool success + greet/uint32 own IP/hash/bool supporter, or reason | Reads success + greet (success) or reason (failure); ignores trailing IP/hash/supporter | ✅ (trailing fields ignored is safe) |
| 2 | SetWaitPort | uint32 port [+ obfuscation type/port] | Sends port only | ✅ (no obfuscation support) |
| 3 | GetPeerAddress (send) | string username | As documented | ✅ |
| 3 | GetPeerAddress (recv) | user, uint32 ip, uint32 port, uint32 obfusc. type, uint16 obfusc. port | Reads user, ip (byte-reversed correctly), port; ignores obfuscation fields. Recorded on the peer connection of that user, for the file connections it may need later, and never dialled on its own: only `connectToUser()` opens a connection, with the address it asked for | ✅ |
| 5 | WatchUser | string username | Encoder exists (`addUser`) but is **never sent**; response (code 5) not handled | 🟡 dead code |
| 7 | GetUserStatus (recv) | user, uint32 status, bool privileged | Reads user + status, `privileged` not read | 🟠 |
| 18 | ConnectToPeer (recv) | user, type, ip, port, uint32 token, bool privileged, obfuscation fields | Reads through token, ignores the rest; dispatches by type P/F/D. Connections are tracked per user **and** type, as nicotine keys them: a relayed request is ignored when one of that type is already up (peers race both routes, and dialling back a peer that needed a relay usually gets refused), while a request of another type is honoured — the same user can be a distributed parent and a peer we exchange files with | ✅ |
| 18 | ConnectToPeer (send) | uint32 token, user, type | Sent by `connectToUser()`, which races a direct connection against a server-relayed one | ✅ |
| 22 | MessageUser (recv) | uint32 id, uint32 timestamp, user, message, bool is_new | Fully parsed and reported as the `private-message` event, acknowledged with MessageAcked(23) as the protocol requires. `is_new` is surfaced as `pending`, for the messages the server kept while we were offline | ✅ |
| 22 | MessageUser (send) | user, message | Sent by `sendPrivateMessage()`, newlines flattened since the server refuses them | ✅ |
| 23 | MessageAcked (send) | uint32 id | Sent for every private message received, without which the server keeps redelivering it | ✅ |
| 26 | FileSearch (send) | uint32 token, string query | Sends 4 raw token bytes + query; token is an opaque, self-consistent 4-byte value | ✅ |
| 26 | FileSearch (recv) | user, token, query | Not handled — search requests are only served via the distributed parent (code D/3) | 🟡 |
| 28 | SetStatus | int32 status | Sends `2` (online) after login | ✅ |
| 35 | SharedFoldersFiles | uint32 dirs, uint32 files | Sends the real counts of the share index after login, and again on `refreshShares()` | ✅ |
| 36 | GetUserStats (recv) | user, avgspeed, uploadnum, unknown, files, dirs | Fully parsed, log only | 🟠 |
| 64 | RoomList (recv) | num, names, **num again**, user counts, then private/owned/operated sections | Reads names, then user counts **without re-reading the second count** → parse is off by 4 bytes from the user-count loop onwards. Log only, so no functional impact | 🟡 misparse |
| 69 | PrivilegedUsers (recv) | uint32 count, usernames | Reads count, log only | 🟠 |
| 71 | HaveNoParent | **bool (1 byte)** | Sends **`uint32` flag (4 bytes)** — accepted by the real server in practice, but off-spec | 🟡 wrong field width |
| 73 | ParentIP | uint32 ip | Sends the 4 ip bytes in received order (equivalent uint32). Message is deprecated in modern docs | ✅ (deprecated) |
| 83 | ParentMinSpeed (recv) | uint32 | Parsed, log only | 🟠 |
| 84 | ParentSpeedRatio (recv) | uint32 | Parsed, log only | 🟠 |
| 102 | NetInfo (recv) | count × (user, ip, port) | Fully parsed; replies ParentIP and connects to each parent as type D | ✅ |
| 104 | WishlistInterval (recv) | uint32 | Parsed, log only | 🟠 |
| 160 | ExcludedSearchPhrases (recv) | uint32 count, count × string | Fully parsed, log only — the phrases are **not** filtered out of the search answers yet | 🟠 |
| 1001 | CantConnectToPeer (recv) | uint32 token | Parsed and reported; the client fails the download bound to that token | ✅ |
| 1001 | CantConnectToPeer (send) | uint32 token, user | Sent when both the direct and the relayed connection attempts to a peer failed | ✅ |
| — | All other server codes (rooms/chat 13–23, interests, user list, 92 CheckPrivileges, 126/127 BranchLevel/Root, 130 ResetDistributed, …) | | Not implemented (chat & rooms are declared out of scope in the README) | ❌ |

## 2. Peer init messages (first message on any P/F/D connection, code field: `uint8`)

Implemented in [`src/server/messages.ts`](../src/server/messages.ts), [`src/listen.ts`](../src/listen.ts) (inbound), peer classes (outbound).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 0 | PierceFireWall | uint32 token | Sent on outbound connections. Inbound: the token is matched against the pending indirect connections of `connectToUser()`, unexpected tokens are dropped | ✅ |
| 1 | PeerInit | own user, type, uint32 token (**always 0** in modern docs) | Sent with our own name (P connections use token 0, F and D carry the transfer/connection token, a legacy convention). Inbound: parsed correctly and used to register the peer. Only P and F are served: a D init is closed rather than read with a peer parser, since distributed children are not implemented, and an init claiming our own name is closed as well | 🟡 legacy token semantics |

## 3. Peer messages (type P, code field: `uint32`)

Implemented in [`src/peer/default-peer/`](../src/peer/default-peer/).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 4 | GetShareFileList (recv) | empty | Handled — answered with the shares of the index (see code 5) | ✅ |
| 5 | SharedFileListResponse (send) | **zlib-compressed**: dirs → files (code **1**, name, uint64 size, ext, attrs), unknown, private dirs | Real shares of the index, zlib compressed, grouped by folder, file code 1, uint64 sizes, extension and attributes of the entry, trailing unknown + private-dir fields | ✅ |
| 5 | SharedFileListResponse (recv) | same | Not handled (client never browses shares) | ❌ |
| 9 | FileSearchResponse (send) | zlib: user, token, n × (code **1**, filename, uint64 size, ext, attrs), bool slotfree, uint32 avgspeed, uint32 queue, uint32 unknown, private results | zlib ✅, file code 1 ✅, real extension ✅, uint64 sizes ✅, slotfree/avgspeed/queue configurable ✅, trailing unknown + private-results count ✅ | ✅ |
| 9 | FileSearchResponse (recv) | same | zlib ✅; parses user, token, files incl. every attribute code the peer sent, uint64 sizes ✅, slotfree, avgspeed, queue length; tolerates truncated trailing fields from older peers | ✅ |
| 15 | UserInfoRequest (send/recv) | empty | Sent by `getUserInfo(user)`. Inbound: answered with UserInfoResponse built from the `userInfo` option | ✅ |
| 16 | UserInfoResponse (send) | description, bool has_picture, [picture], uint32 uploadslots, uint32 queuesize, bool slotsfree, [uint32 uploadpermitted] | All fields, picture and upload permission included. Slots, queue size and permission come from the real state of the upload queue, overridden by whatever the `userInfo` option sets | ✅ |
| 16 | UserInfoResponse (recv) | same | Parsed and surfaced by `getUserInfo()`; peers that stop after any field are tolerated, and a picture shorter than announced is dropped | ✅ |
| 36 | FolderContentsRequest (recv) | **uint32 token, string folder** | Parsed as documented and answered with FolderContentsResponse (37) built from the index | ✅ |
| 37 | FolderContentsResponse | zlib folder listing | Echoes the token and the requested folder, then the folder → files structure, zlib compressed | ✅ |
| 40 | TransferRequest (send) | dir 0: direction, token, filename; dir 1 adds **uint64** filesize | dir 0 sent only to a peer that answered nothing to QueueUpload (43), which is the request tried first. dir 1 announces an upload when a slot frees, with the size the provider reports at that moment | ✅ |
| 40 | TransferRequest (recv) | dir 1 adds **uint64** filesize | Reported to the client, which accepts after 200 ms with TransferResponse **only when it asked for that file** and refuses the rest. Filesize read as **uint64** ✅. A dir-0 request (peer downloading from us) is queued and answered with the `Queued` refusal, as nicotine does, then announced with our own dir-1 request — answering `allowed` would let a spoofed request open a file connection. Denied outright when uploads are off | ✅ |
| 41 | TransferResponse (send) | token, bool allowed [, reason] | Sends `token, 1` for a transfer we asked for (upload flavour, 41b), and `token, 0, reason` to refuse one | ✅ |
| 41 | TransferResponse (recv) | allowed=1 [+ uint64 size in deprecated 41a] / allowed=0 + reason | Handled for both directions. Our download: allowed → opens the F connection; 'Queued' → marked queued and its place asked for; any other reason → it fails with it. Our upload: allowed → the F connection is opened towards the peer; a refusal frees the slot | ✅ |
| 43 | QueueUpload (send) | string filename | Download initiation: the peer queues the file and comes back with its own TransferRequest. A peer that answers nothing at all is asked with TransferRequest(dir 0) instead, see §6.5 | ✅ |
| 43 | QueueUpload (recv) | string filename | Resolved against the share index and queued when `uploads` is on: unknown paths are refused with `File not shared.`, a peer over `queueLimit` with `Too many files`. Answered with UploadDenied('Uploads are disabled') when the client only shares a file list | ✅ |
| 44 | PlaceInQueueResponse (recv) | filename, uint32 place | Surfaced as the `download-queue` client event | ✅ |
| 44 | PlaceInQueueResponse (send) | filename, uint32 place | Answers a PlaceInQueueRequest with the position in our queue, counted from 1 | ✅ |
| 46 | UploadFailed (recv) | string filename | Handled — rejects the matching pending download / destroys the stream | ✅ |
| 46 | UploadFailed (send) | string filename | Sent when a transfer we had announced cannot happen after all (provider error, connection lost) | ✅ |
| 50 | UploadDenied (recv) | filename, reason | Handled — rejects the pending download promise with the peer's reason (or destroys the stream) and forgets the transfer tokens | ✅ |
| 50 | UploadDenied (send) | filename, reason | `File not shared.`, `File read error.`, `Too many files`, or `Uploads are disabled` for a client that shares without serving. None of them is one of the internal statuses clients rewrite to 'Cancelled' | ✅ |
| 51 | PlaceInQueueRequest (send) | string filename | Sent after QueueUpload to learn our position in the queue of the peer, then again every `queuePollInterval` (60 s) while the file waits, as nicotine does every 5 min. A peer that answered before and then leaves `queuePollRetries` (3) of them unanswered no longer has the file queued, so the download fails instead of waiting forever | ✅ |
| 51 | PlaceInQueueRequest (recv) | string filename | Answered with PlaceInQueueResponse (44) when the file is waiting in our queue, ignored when it is not. Log only when uploads are off, since nothing can be queued then | ✅ |
| 8, 10, 14, 33, 34, 42, 47–49, 52 | Obsolete/deprecated messages | — | Not implemented | ⚪ |

## 4. Distributed messages (type D, code field: `uint8`)

Implemented in [`src/peer/distributed-peer/`](../src/peer/distributed-peer/).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 0 | DistribPing | empty | Not handled (falls into "unknown code" log) | ❌ |
| 3 | DistribSearch (recv) | uint32 identifier, user, uint32 token, query | Fully parsed; duplicate requests de-duplicated; matches are answered with FileSearchResponse via a P connection (looked up through GetPeerAddress when needed) | ✅ |
| 3 | DistribSearch (send) | same | Never forwarded — the client acts as a **leaf with no children**, which is tolerated but see the process notes below | 🟡 |
| 4 | DistribBranchLevel (recv) | int32 level | Parsed, log only — not echoed to the server (server code 126) | 🟠 |
| 5 | DistribBranchRoot (recv) | string root | Parsed, log only — not echoed to the server (server code 127) | 🟠 |
| 7 | DistribChildDepth | uint32 depth | Not implemented | ❌ |
| 93 | DistribEmbeddedMessage | uint8 code + payload | Not implemented — modern servers deliver searches this way when acting as branch root | ❌ |

## 5. File connection (type F) — [`src/peer/file-peer/`](../src/peer/file-peer/)

Documented sequence: connect → PeerInit(token 0)/PierceFireWall → downloader sends `uint32 token` → downloader sends `uint64 offset` → uploader streams → **downloader closes** when complete.

| Step | Doc | Implementation | Status |
|------|-----|----------------|--------|
| Outbound F after TransferResponse allowed | PeerInit with token 0, then uint32 transfer token | PeerInit carries the transfer token itself; the separate `uint32 token` message is **not** sent (legacy convention) | 🟡 works with legacy uploaders |
| Inbound-triggered F (ConnectToPeer type F) | PierceFireWall(token), read uploader's uint32 token | ✅ Pierce sent, first 4 received bytes used as the transfer token | ✅ |
| Offset | uint64 offset (0 = fresh, other = resume) | Sends the offset of the download, non zero when `download({ offset })` resumes a partial file | ✅ |
| Data & completion | Downloader closes at expected size | Buffers data (and feeds the optional stream), calls `conn.end()` once the expected size is received: the size the peer announced, or the one the search result reported when no message carried it (legacy flow). A transfer whose size is unknown ends when the uploader closes | ✅ |
| Completion bookkeeping | — | File written to disk, promise resolved with path + buffer | ✅ (client-side concern) |
| Outbound F to send a file | PeerInit(token 0), then the uint32 transfer token, read the uint64 offset, stream | Implemented as documented: PeerInit carries token 0, FileTransferInit carries the transfer token, the offset the downloader sends is honoured (`read({ start })`), and the bytes go out with backpressure. A peer we have no address for is asked through ConnectToPeer(type F) to open the connection itself | ✅ |

## 6. Process-level compliance

### 6.1 Login — ✅ compliant
`login()` → TCP connect → Login(1) → on success SharedFoldersFiles(35), HaveNoParent(71), SetStatus(28), SetWaitPort(2) — matches the documented session bootstrap. Anything asked for before the login is queued by [`Server`](../src/server/server.ts) and sent by `onLoggedIn()`, since the server drops what arrives without a session. Nothing else is done between the TCP connect and Login(1): the share listing runs after the login, so the connection never sits unauthenticated while a large share is walked. Deviation: HaveNoParent flag width was fixed to a single byte; share counts come from the index.

The connection is kept under TCP keepalive (the protocol has no ping a client is expected to send: ServerPing is deprecated and answered by nothing), and when it drops the whole bootstrap is replayed on a new connection, credentials included, with a growing delay between the attempts. `reconnect: false` leaves it to the caller, which the `server-disconnect` event tells about it either way. Relogged(41) is not a dropped connection but a dropped session: another client logged in with the same name, so the client reports it as `relogged` and lets a new `login()` through instead of racing it.

### 6.2 Peer connection establishment — ✅ compliant
- **Direct outbound** (P/D after GetPeerAddress/NetInfo): compliant, though the D handshake sends *both* PeerInit and PierceFireWall on connect — the docs prescribe one or the other depending on who initiated.
- **Indirect inbound** (server ConnectToPeer 18): compliant for P/F/D dispatch. Only one peer connection per user is kept, so a relayed request for a peer that already reached us is answered on the connection it opened.
- **Fallbacks**: `connectToUser()` races a direct connection against a server-relayed one (ConnectToPeer 18); inbound PierceFireWall tokens are matched to those pending requests, and CantConnectToPeer(1001) is reported when both attempts fail.
- **Dials** give up after 10 s instead of waiting for the system to declare the address unreachable, which takes minutes: a peer behind a router that drops our packets would otherwise look like a peer that answers nothing, since what is written on a socket still being dialled waits in its buffer and dies with it.

### 6.3 Search (outgoing) — ✅ compliant
FileSearch(26) → results collected from peers' FileSearchResponse(9) until the client-side timeout. Attributes are surfaced as a map keyed by their code, unknown ones included, and slotfree/avgspeed as `slots`/`speed`. Only caveat: uint64 file sizes truncated to the low 32 bits.

### 6.4 Search (serving, distributed network) — 🟡 partial
The client joins the distributed network as documented (HaveNoParent → NetInfo → connect to parent as D → answer DistribSearch). Deviations:
- Never sends HaveNoParent(0)/BranchLevel/BranchRoot once a parent is acquired, so the server keeps treating it as parentless.
- No children are accepted and searches are not forwarded (permanent leaf).
- DistribPing and EmbeddedMessage(93) are unanswered, so a modern branch-root path is not supported.

### 6.5 Download — ✅ compliant with the *modern* flow, legacy fallback
The flow is the modern one: QueueUpload(43) → PlaceInQueueRequest(51) → the peer answers with its own TransferRequest(dir 1) → TransferResponse(allowed) → F connection.

Nothing in the protocol says whether a peer understands QueueUpload, and a peer that does not simply answers nothing, so a download that got no answer at all after `queueFallbackDelay` (5 min) is asked again with the legacy TransferRequest(40, dir 0). The verdict is remembered per peer connection, so only the first download from such a peer waits — which is why the wait is long: a peer that answers a place request a minute later is a peer we must not remember as one that never understood the queue. A peer that answers PlaceInQueueResponse(44), QueueFailed(46) or UploadDenied(50) is known to speak the queue flow and never gets the legacy request.

Silence only counts when the connection is still up: a request that never left the buffer of a socket says nothing about the peer, so its verdict is left untouched — and the download is **not** settled. A queued file survives the peer connection dropping, since the peer keeps the request on its side and announces the transfer when our turn comes, on whatever connection exists then. Giving up is left to `downloadTimeout`, `DownloadOptions.timeout` and the caller.

A refusal of the legacy request is now acted upon: TransferResponse(allowed=0) with 'Queued' marks the download queued and asks for its place, any other reason ('Queue full', 'File not shared', 'Banned'...) fails it, where it used to be logged and forgotten — leaving the download pending forever.

A download the caller gives up on (`Download.cancel()`, an aborted `AbortSignal` or the inactivity timeout) is only dropped locally: no message exists for a downloader to withdraw a queued file, and the deprecated 47–49 codes are not it. The transfer the peer may still announce afterwards is answered with TransferResponse(allowed=0, 'Cancelled'), which is what the docs prescribe for a transfer nobody asked for.

On the viability of the legacy flow across the network: **no mainstream client has dropped support for receiving dir-0 requests** — the docs note that "Nicotine+ ≥ 3.0.3, Museek+ and the official clients use QueueUpload today" as senders, but keep understanding dir-0 because "clients like slskd and Seeker still use this method for downloading". The practical caveat is different: the docs *discourage* answering a dir-0 request with `allowed=1` (a spoofed peer could initiate the file connection), recommending a "Queued" rejection followed by the uploader's own TransferRequest. So against modern uploaders the legacy flow degrades into the queued path anyway — both response paths are handled here.

### 6.6 Sharing — ✅ browsing, searching and uploading
Shares come from [`ShareProvider`](../src/share/provider.ts) implementations (local file system, memory, or anything a user plugs in) indexed by [`ShareIndex`](../src/share/share-index.ts). What is compliant: real SharedFoldersFiles(35) counts, compressed SharedFileListResponse(5), FolderContentsResponse(37), FileSearchResponse(9) with sizes, extensions and attributes, and virtual `\` separated paths as other clients advertise.

Serving the bytes is implemented, behind the `uploads` option (off by default, and a client that does not serve says so: 0 slots, no free slot and UploadPermission.NoOne in its user info, `slotfree=0` in its search answers, and UploadDenied('Uploads are disabled') to whoever asks anyway).

The uploading flow, when it is on: QueueUpload(43) → the path is resolved against the index → the file waits in one queue, oldest request first, its position answered to PlaceInQueueRequest(51) → a free slot announces it with TransferRequest(dir 1, our own token, the size the provider reports at that moment) → TransferResponse(allowed) → PeerInit('F', token 0) + FileTransferInit(token) on a file connection → the uint64 offset the downloader sends is honoured, and `read(entry, { start })` streams the rest at the pace the peer reads it.

Deviations and deliberate choices:

- a legacy TransferRequest(dir 0) is **not** answered `allowed=1`, as the docs recommend: it is queued and refused with 'Queued', then announced with our own dir-1 request, so nothing but a transfer we announced can open a file connection
- refusal reasons are the documented ones (`File not shared.`, `File read error.`, `Too many files`), none of which a client rewrites to 'Cancelled'
- the file connection is opened towards the peer, at the address of the peer connection or the one GetPeerAddress(3) reports (a peer connection only ever carries the ephemeral port of the peer). Only when that fails, or when the server reports port 0, is ConnectToPeer(type F) used to have the peer open it instead — which needs our own listening port to be reachable, since the server hands the peer the address it has for us
- a downloader that stops reading for `transferTimeout` ms loses the connection and the slot, and UploadFailed(46) is sent when a transfer we had announced cannot happen
- privileged users get no priority in the queue, and there is no per-peer rate limit or ban list

### 6.7 User info — ✅ both ways

`getUserInfo(user)` asks a peer with UserInfoRequest(15) and resolves with what it answers, picture included. Incoming requests are answered from the real upload state (slots, queue size, free slot, permission), with whatever the `userInfo` client option sets on top. Note that this is the *peer* message: the server-side GetUserStats(36)/GetUserStatus(7) are still not implemented.

### 6.7b Private messages — ✅ both ways

MessageUser(22) is parsed, reported as `private-message` and acknowledged with MessageAcked(23), which is not optional: the server redelivers an unacknowledged message on every session. `sendPrivateMessage()` sends one, and the server queues it for a user who is offline. Not implemented around them: the CTCP queries (`\x01VERSION\x01`) some clients answer, and MessageUsers(149), the broadcast to a list of users.

### 6.8 Chat rooms, interests — ❌ not implemented (declared out of scope)

---

## 7. Prioritized deviations

Actual bugs (fixable without new features):

1. ~~**FileSearchResponse file code sent as 0, doc says 1**~~ — **fixed**, file entries are written with code 1.
2. ~~**UploadDenied(50) doesn't reject the pending download**~~ — **fixed**, the pending download is rejected with the peer's reason and forgotten (covered by [default-peer.test.ts](../test/default-peer.test.ts)).
3. ~~**uint64 file sizes read/written as uint32**~~ — **fixed**, all size fields use `Message.int64` (covered with > 4 GiB values in [message.test.ts](../test/message.test.ts), [message-factory.test.ts](../test/message-factory.test.ts) and [default-peer.test.ts](../test/default-peer.test.ts)).
4. ~~**HaveNoParent sent as 4 bytes instead of 1**~~ — **fixed**, single-byte boolean.
5. ~~**FolderContentsRequest misparsed** and **RoomList misparse**~~ — **fixed**, FolderContentsRequest is answered with a FolderContentsResponse and RoomList consumes the repeated count.
6. ~~**FileSearchResponse trailing fields omitted**~~ — **fixed**, `unknown` and private-results count are written.

Missing protocol behavior (features):

7. ~~Indirect connection requests (send ConnectToPeer 18) + CantConnectToPeer reporting~~ — **done**, see `connectToUser()`.
8. ~~Modern download initiation (QueueUpload 43) and queue tracking (44/51)~~ — **done**, QueueUpload is the default flow, the queue place is surfaced as the `download-queue` event.
9. Distributed-network upkeep (BranchLevel/BranchRoot to server, HaveNoParent(0), Ping, EmbeddedMessage 93, children).
10. ~~Actual uploads: upload slots and queue (43/44/51), TransferRequest(dir 1), and the uploader side of the file connection~~ — **done**, behind the `uploads` option (see 6.6). What is still missing around them: privileged users are not served first, and there is no per-peer rate limit or ban list.
11. ~~Download resume (non-zero offset on F connections)~~ — **done**, see `DownloadOptions.offset`.
