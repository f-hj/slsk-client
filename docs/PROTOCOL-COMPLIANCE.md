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
| 3 | GetPeerAddress (recv) | user, uint32 ip, uint32 port, uint32 obfusc. type, uint16 obfusc. port | Reads user, ip (byte-reversed correctly), port; ignores obfuscation fields | ✅ |
| 5 | WatchUser | string username | Encoder exists (`addUser`) but is **never sent**; response (code 5) not handled | 🟡 dead code |
| 7 | GetUserStatus (recv) | user, uint32 status, bool privileged | Reads user + status, `privileged` not read | 🟠 |
| 18 | ConnectToPeer (recv) | user, type, ip, port, uint32 token, bool privileged, obfuscation fields | Reads through token, ignores the rest; dispatches by type P/F/D | ✅ |
| 18 | ConnectToPeer (send) | uint32 token, user, type | Sent by `connectToUser()`, which races a direct connection against a server-relayed one | ✅ |
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
| 1001 | CantConnectToPeer (recv) | uint32 token | Parsed and reported; the client fails the download bound to that token | ✅ |
| 1001 | CantConnectToPeer (send) | uint32 token, user | Sent when both the direct and the relayed connection attempts to a peer failed | ✅ |
| — | All other server codes (rooms/chat 13–23, interests, user list, 92 CheckPrivileges, 126/127 BranchLevel/Root, 130 ResetDistributed, …) | | Not implemented (chat & rooms are declared out of scope in the README) | ❌ |

## 2. Peer init messages (first message on any P/F/D connection, code field: `uint8`)

Implemented in [`src/server/messages.ts`](../src/server/messages.ts), [`src/listen.ts`](../src/listen.ts) (inbound), peer classes (outbound).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 0 | PierceFireWall | uint32 token | Sent on outbound connections. Inbound: the token is matched against the pending indirect connections of `connectToUser()`, unexpected tokens are dropped | ✅ |
| 1 | PeerInit | own user, type, uint32 token (**always 0** in modern docs) | Sent with our own name (P connections use token 0, F and D carry the transfer/connection token, a legacy convention). Inbound: parsed correctly and used to register the peer | 🟡 legacy token semantics |

## 3. Peer messages (type P, code field: `uint32`)

Implemented in [`src/peer/default-peer/`](../src/peer/default-peer/).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 4 | GetShareFileList (recv) | empty | Handled — answered with the shares of the index (see code 5) | ✅ |
| 5 | SharedFileListResponse (send) | **zlib-compressed**: dirs → files (code **1**, name, uint64 size, ext, attrs), unknown, private dirs | Real shares of the index, zlib compressed, grouped by folder, file code 1, uint64 sizes, extension and attributes of the entry, trailing unknown + private-dir fields | ✅ |
| 5 | SharedFileListResponse (recv) | same | Not handled (client never browses shares) | ❌ |
| 9 | FileSearchResponse (send) | zlib: user, token, n × (code **1**, filename, uint64 size, ext, attrs), bool slotfree, uint32 avgspeed, uint32 queue, uint32 unknown, private results | zlib ✅, file code 1 ✅, real extension ✅, uint64 sizes ✅, slotfree/avgspeed/queue configurable ✅, trailing unknown + private-results count ✅ | ✅ |
| 9 | FileSearchResponse (recv) | same | zlib ✅; parses user, token, files incl. attributes (bitrate/duration/vbr/… surfaced), uint64 sizes ✅, slotfree, avgspeed, queue length; tolerates truncated trailing fields from older peers | ✅ |
| 15/16 | UserInfoRequest/Response | — | Not implemented (peers asking for our info get no answer) | ❌ |
| 36 | FolderContentsRequest (recv) | **uint32 token, string folder** | Parsed as documented and answered with FolderContentsResponse (37) built from the index | ✅ |
| 37 | FolderContentsResponse | zlib folder listing | Echoes the token and the requested folder, then the folder → files structure, zlib compressed | ✅ |
| 40 | TransferRequest (send) | dir 0: direction, token, filename | Only sent when a download opts into the legacy flow with `request: 'transfer'`; the default download path uses QueueUpload (43) | ✅ (legacy opt-in) |
| 40 | TransferRequest (recv) | dir 1 adds **uint64** filesize | Reported to the client, which accepts after 200 ms with TransferResponse **only when it asked for that file** and refuses the rest. Filesize read as **uint64** ✅; dir-0 requests (peer downloading from us) are denied with a reason | ✅ |
| 41 | TransferResponse (send) | token, bool allowed | Sends `token, 1` (upload flavour, 41b) | ✅ |
| 41 | TransferResponse (recv) | allowed=1 [+ uint64 size in deprecated 41a] / allowed=0 + reason | Handled: allowed → opens F connection; denied → reads reason, cleans token, waits for the peer's TransferRequest | ✅ |
| 43 | QueueUpload (send) | string filename | Default download initiation: the peer queues the file and comes back with its own TransferRequest | ✅ |
| 43 | QueueUpload (recv) | string filename | Answered with UploadDenied — uploading is not supported | ✅ (denied) |
| 44 | PlaceInQueueResponse (recv) | filename, uint32 place | Surfaced as the `download-queue` client event | ✅ |
| 46 | UploadFailed (recv) | string filename | Handled — rejects the matching pending download / destroys the stream | ✅ |
| 50 | UploadDenied (recv) | filename, reason | Handled — rejects the pending download promise with the peer's reason (or destroys the stream) and forgets the transfer tokens | ✅ |
| 51 | PlaceInQueueRequest (send) | string filename | Sent after QueueUpload to learn our position in the queue of the peer | ✅ |
| 51 | PlaceInQueueRequest (recv) | string filename | Parsed, log only — nothing is ever queued on our side | 🟠 |
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
| Data & completion | Downloader closes at expected size | Buffers data (and feeds the optional stream), calls `conn.end()` once `size` bytes received | ✅ |
| Completion bookkeeping | — | File written to disk, promise resolved with path + buffer | ✅ (client-side concern) |

## 6. Process-level compliance

### 6.1 Login — ✅ compliant
`connect()` → TCP connect → Login(1) → on success SharedFoldersFiles(35), HaveNoParent(71), SetStatus(28), SetWaitPort(2) — matches the documented session bootstrap. Deviation: HaveNoParent flag width was fixed to a single byte; share counts come from the index.

### 6.2 Peer connection establishment — ✅ compliant
- **Direct outbound** (P/D after GetPeerAddress/NetInfo): compliant, though the D handshake sends *both* PeerInit and PierceFireWall on connect — the docs prescribe one or the other depending on who initiated.
- **Indirect inbound** (server ConnectToPeer 18): compliant for P/F/D dispatch.
- **Fallbacks**: `connectToUser()` races a direct connection against a server-relayed one (ConnectToPeer 18); inbound PierceFireWall tokens are matched to those pending requests, and CantConnectToPeer(1001) is reported when both attempts fail.

### 6.3 Search (outgoing) — ✅ compliant
FileSearch(26) → results collected from peers' FileSearchResponse(9) until the client-side timeout. Attribute 0 is surfaced as `bitrate`, slotfree/avgspeed surfaced as `slots`/`speed`. Only caveat: uint64 file sizes truncated to the low 32 bits.

### 6.4 Search (serving, distributed network) — 🟡 partial
The client joins the distributed network as documented (HaveNoParent → NetInfo → connect to parent as D → answer DistribSearch). Deviations:
- Never sends HaveNoParent(0)/BranchLevel/BranchRoot once a parent is acquired, so the server keeps treating it as parentless.
- No children are accepted and searches are not forwarded (permanent leaf).
- DistribPing and EmbeddedMessage(93) are unanswered, so a modern branch-root path is not supported.

### 6.5 Download — ✅ compliant with the *modern* flow, legacy opt-in
The default flow is the modern one: QueueUpload(43) → PlaceInQueueRequest(51) → the peer answers with its own TransferRequest(dir 1) → TransferResponse(allowed) → F connection. `download({ request: 'transfer' })` opts into the legacy TransferRequest(40, dir 0) initiation instead.

On the viability of the legacy flow across the network: **no mainstream client has dropped support for receiving dir-0 requests** — the docs note that "Nicotine+ ≥ 3.0.3, Museek+ and the official clients use QueueUpload today" as senders, but keep understanding dir-0 because "clients like slskd and Seeker still use this method for downloading". The practical caveat is different: the docs *discourage* answering a dir-0 request with `allowed=1` (a spoofed peer could initiate the file connection), recommending a "Queued" rejection followed by the uploader's own TransferRequest. So against modern uploaders the legacy flow degrades into the queued path anyway — both response paths are handled here.

### 6.6 Sharing — ✅ browsing and searching, ❌ uploading
Shares come from [`ShareProvider`](../src/share/provider.ts) implementations (local file system, memory, or anything a user plugs in) indexed by [`ShareIndex`](../src/share/share-index.ts). What is compliant: real SharedFoldersFiles(35) counts, compressed SharedFileListResponse(5), FolderContentsResponse(37), FileSearchResponse(9) with sizes, extensions and attributes, and virtual `\` separated paths as other clients advertise.

What is still missing is serving the bytes: TransferRequest(dir 1) is never sent, QueueUpload(43) and TransferRequest(dir 0) are answered with a denial, PlaceInQueueRequest(51) answers nothing, and no file connection is ever opened as the uploader. The `read(entry, { start })` side of the provider interface exists for it and is unused so far.

### 6.7 Chat, rooms, user info, interests — ❌ not implemented (declared out of scope)

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
10. Actual uploads: upload slots and queue (43/44/51), TransferRequest(dir 1), and the uploader side of the file connection. Browsing and searching the shares is implemented (see 6.6).
11. ~~Download resume (non-zero offset on F connections)~~ — **done**, see `DownloadOptions.offset`.
