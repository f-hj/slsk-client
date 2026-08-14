# Soulseek Protocol Compliance Report

Reference: [nicotine-plus SLSKPROTOCOL.html](https://nicotine-plus.org/doc/SLSKPROTOCOL.html) (checked 2026-08-12).

Legend for the *Status* column:

- ✅ **Compliant** — wire format matches the documentation
- 🟡 **Partial** — works in practice, but deviates from the documented layout or only reads/writes a subset
- 🟠 **Log only** — message is parsed (fully or partly) but only debug-logged, no behavior
- ❌ **Missing** — not implemented at all
- ⚪ **N/A** — obsolete/deprecated in the protocol, intentionally not implemented

All messages are framed as `uint32 length (LE) + payload` and re-assembled by [`Messages`](../src/messages.ts), including partial TCP chunks — compliant with the documented framing.

---

## 1. Server messages (connection to server.slsknet.org:2242)

Implemented in [`src/server.ts`](../src/server.ts) (receive + send helpers) and [`src/message-factory.ts`](../src/message-factory.ts) (encoding). Code field: `uint32`.

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
| 18 | ConnectToPeer (send) | uint32 token, user, type | **Never sent** — the client never asks the server to relay a connection (it only connects directly) | ❌ |
| 26 | FileSearch (send) | uint32 token, string query | Sends 4 raw token bytes + query; token is an opaque, self-consistent 4-byte value | ✅ |
| 26 | FileSearch (recv) | user, token, query | Not handled — search requests are only served via the distributed parent (code D/3) | 🟡 |
| 28 | SetStatus | int32 status | Sends `2` (online) after login | ✅ |
| 35 | SharedFoldersFiles | uint32 dirs, uint32 files | Sends **hardcoded `1, 1`** regardless of actual shares | 🟡 layout ok, values wrong |
| 36 | GetUserStats (recv) | user, avgspeed, uploadnum, unknown, files, dirs | Fully parsed, log only | 🟠 |
| 64 | RoomList (recv) | num, names, **num again**, user counts, then private/owned/operated sections | Reads names, then user counts **without re-reading the second count** → parse is off by 4 bytes from the user-count loop onwards. Log only, so no functional impact | 🟡 misparse |
| 69 | PrivilegedUsers (recv) | uint32 count, usernames | Reads count, log only | 🟠 |
| 71 | HaveNoParent | **bool (1 byte)** | Sends **`uint32` flag (4 bytes)** — accepted by the real server in practice, but off-spec | 🟡 wrong field width |
| 73 | ParentIP | uint32 ip | Sends the 4 ip bytes in received order (equivalent uint32). Message is deprecated in modern docs | ✅ (deprecated) |
| 83 | ParentMinSpeed (recv) | uint32 | Parsed, log only | 🟠 |
| 84 | ParentSpeedRatio (recv) | uint32 | Parsed, log only | 🟠 |
| 102 | NetInfo (recv) | count × (user, ip, port) | Fully parsed; replies ParentIP and connects to each parent as type D | ✅ |
| 104 | WishlistInterval (recv) | uint32 | Parsed, log only | 🟠 |
| 1001 | CantConnectToPeer (recv) | uint32 token | Parsed, log only — the pending download for that token is **not** failed | 🟠 |
| 1001 | CantConnectToPeer (send) | uint32 token, user | **Never sent** when an indirect connection fails on our side | ❌ |
| — | All other server codes (rooms/chat 13–23, interests, user list, 92 CheckPrivileges, 126/127 BranchLevel/Root, 130 ResetDistributed, …) | | Not implemented (chat & rooms are declared out of scope in the README) | ❌ |

## 2. Peer init messages (first message on any P/F/D connection, code field: `uint8`)

Implemented in [`src/message-factory.ts`](../src/message-factory.ts), [`src/listen.ts`](../src/listen.ts) (inbound), peer classes (outbound).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 0 | PierceFireWall | uint32 token | Sent on outbound connections (both via factory and as a hand-rolled `05000000 00 <token>` buffer — identical bytes). Inbound: token logged, but the connection is **not matched** to a pending transfer | 🟡 send ✅ / receive 🟠 |
| 1 | PeerInit | own user, type, uint32 token (**always 0** in modern docs) | Sent with the *transfer/connection token* instead of 0 (legacy convention). Inbound: parsed correctly and used to register the peer | 🟡 legacy token semantics |

## 3. Peer messages (type P, code field: `uint32`)

Implemented in [`src/peer/default-peer.ts`](../src/peer/default-peer.ts).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 4 | GetShareFileList (recv) | empty | Handled — but responds with a fake list (see code 5) | ✅ |
| 5 | SharedFileListResponse (send) | **zlib-compressed**: dirs → files (code **1**, name, uint64 size, ext, attrs), unknown, private dirs | Sends a **hardcoded fake** single folder/file, **uncompressed**, without the trailing unknown/private-dir fields | ❌ non-compliant (uncompressed + fake data) |
| 5 | SharedFileListResponse (recv) | same | Not handled (client never browses shares) | ❌ |
| 9 | FileSearchResponse (send) | zlib: user, token, n × (code **1**, filename, uint64 size, ext, attrs), bool slotfree, uint32 avgspeed, uint32 queue, uint32 unknown, private results | zlib ✅, file code 1 ✅, real extension ✅, uint64 sizes ✅, slotfree/avgspeed/queue configurable ✅, trailing unknown + private-results count ✅ | ✅ |
| 9 | FileSearchResponse (recv) | same | zlib ✅; parses user, token, files incl. attributes (bitrate/duration/vbr/… surfaced), uint64 sizes ✅, slotfree, avgspeed, queue length; tolerates truncated trailing fields from older peers | ✅ |
| 15/16 | UserInfoRequest/Response | — | Not implemented (peers asking for our info get no answer) | ❌ |
| 36 | FolderContentsRequest (recv) | **uint32 token, string folder** | Misparsed as "number of files" (reads the token as a count), log only; no FolderContentsResponse (37) is sent | ❌ misparse + no response |
| 37 | FolderContentsResponse | zlib folder listing | Not implemented | ❌ |
| 40 | TransferRequest (send) | dir 0: direction, token, filename | Sent to start downloads (**legacy** initiation — modern flow is QueueUpload 43, but dir-0 requests are still accepted network-wide) | 🟡 deprecated-but-accepted |
| 40 | TransferRequest (recv) | dir 1 adds **uint64** filesize | Handled; accepts after 200 ms with TransferResponse. Filesize read as **uint64** ✅; dir-0 requests (peer downloading from us) are denied with a reason | ✅ |
| 41 | TransferResponse (send) | token, bool allowed | Sends `token, 1` (upload flavour, 41b) | ✅ |
| 41 | TransferResponse (recv) | allowed=1 [+ uint64 size in deprecated 41a] / allowed=0 + reason | Handled: allowed → opens F connection; denied → reads reason, cleans token, waits for the peer's TransferRequest | ✅ |
| 43 | QueueUpload | string filename | **Not sent** (downloads use legacy 40/dir 0) and **not handled** on receive | ❌ |
| 44 | PlaceInQueueResponse | filename, uint32 place | Not implemented | ❌ |
| 46 | UploadFailed (recv) | string filename | Handled — rejects the matching pending download / destroys the stream | ✅ |
| 50 | UploadDenied (recv) | filename, reason | Handled — rejects the pending download promise with the peer's reason (or destroys the stream) and forgets the transfer tokens | ✅ |
| 51 | PlaceInQueueRequest | string filename | Not implemented | ❌ |
| 8, 10, 14, 33, 34, 42, 47–49, 52 | Obsolete/deprecated messages | — | Not implemented | ⚪ |

## 4. Distributed messages (type D, code field: `uint8`)

Implemented in [`src/peer/distributed-peer.ts`](../src/peer/distributed-peer.ts).

| Code | Name | Doc layout | Implementation | Status |
|------|------|-----------|----------------|--------|
| 0 | DistribPing | empty | Not handled (falls into "unknown code" log) | ❌ |
| 3 | DistribSearch (recv) | uint32 identifier, user, uint32 token, query | Fully parsed; duplicate requests de-duplicated; matches are answered with FileSearchResponse via a P connection (looked up through GetPeerAddress when needed) | ✅ |
| 3 | DistribSearch (send) | same | Never forwarded — the client acts as a **leaf with no children**, which is tolerated but see the process notes below | 🟡 |
| 4 | DistribBranchLevel (recv) | int32 level | Parsed, log only — not echoed to the server (server code 126) | 🟠 |
| 5 | DistribBranchRoot (recv) | string root | Parsed, log only — not echoed to the server (server code 127) | 🟠 |
| 7 | DistribChildDepth | uint32 depth | Not implemented | ❌ |
| 93 | DistribEmbeddedMessage | uint8 code + payload | Not implemented — modern servers deliver searches this way when acting as branch root | ❌ |

## 5. File connection (type F) — [`src/peer/download-peer-file.ts`](../src/peer/download-peer-file.ts)

Documented sequence: connect → PeerInit(token 0)/PierceFireWall → downloader sends `uint32 token` → downloader sends `uint64 offset` → uploader streams → **downloader closes** when complete.

| Step | Doc | Implementation | Status |
|------|-----|----------------|--------|
| Outbound F after TransferResponse allowed | PeerInit with token 0, then uint32 transfer token | PeerInit carries the transfer token itself; the separate `uint32 token` message is **not** sent (legacy convention) | 🟡 works with legacy uploaders |
| Inbound-triggered F (ConnectToPeer type F) | PierceFireWall(token), read uploader's uint32 token | ✅ Pierce sent, first 4 received bytes used as the transfer token | ✅ |
| Offset | uint64 offset (0 = fresh, other = resume) | Always sends 8 zero bytes = offset 0. **No resume support** | 🟡 |
| Data & completion | Downloader closes at expected size | Buffers data (and feeds the optional stream), calls `conn.end()` once `size` bytes received | ✅ |
| Completion bookkeeping | — | File written to disk, promise resolved with path + buffer | ✅ (client-side concern) |

## 6. Process-level compliance

### 6.1 Login — ✅ compliant
`connect()` → TCP connect → Login(1) → on success SharedFoldersFiles(35), HaveNoParent(71), SetStatus(28), SetWaitPort(2) — matches the documented session bootstrap. Deviations: HaveNoParent flag width (uint32 vs bool) and hardcoded share counts.

### 6.2 Peer connection establishment — 🟡 partial
- **Direct outbound** (P/D after GetPeerAddress/NetInfo): compliant, though the D handshake sends *both* PeerInit and PierceFireWall on connect — the docs prescribe one or the other depending on who initiated.
- **Indirect inbound** (server ConnectToPeer 18): compliant for P/F/D dispatch.
- **Fallbacks missing**: the client never sends ConnectToPeer(18) to request a relayed connection when a direct attempt fails, and never reports CantConnectToPeer(1001). A firewalled peer that can't be reached directly is silently unreachable.
- Inbound PierceFireWall on the listen port is logged but not associated with any pending transfer.

### 6.3 Search (outgoing) — ✅ compliant
FileSearch(26) → results collected from peers' FileSearchResponse(9) until the client-side timeout. Attribute 0 is surfaced as `bitrate`, slotfree/avgspeed surfaced as `slots`/`speed`. Only caveat: uint64 file sizes truncated to the low 32 bits.

### 6.4 Search (serving, distributed network) — 🟡 partial
The client joins the distributed network as documented (HaveNoParent → NetInfo → connect to parent as D → answer DistribSearch). Deviations:
- Never sends HaveNoParent(0)/BranchLevel/BranchRoot once a parent is acquired, so the server keeps treating it as parentless.
- No children are accepted and searches are not forwarded (permanent leaf).
- DistribPing and EmbeddedMessage(93) are unanswered, so a modern branch-root path is not supported.

### 6.5 Download — 🟡 compliant with the *legacy* flow
Uses TransferRequest(40, direction 0) instead of the modern QueueUpload(43). The docs confirm dir-0 requests are still understood network-wide ("slskd and Seeker still use it"), and both response paths (immediate allow → F connection; deny → wait for the peer's own TransferRequest) are handled. Gaps: UploadDenied(50) doesn't fail the pending download, CantConnectToPeer doesn't either, no queue-place tracking (44/51), no resume.

### 6.6 Upload / sharing — ❌ not compliant (declared out of scope)
The client answers GetShareFileList with a fake, uncompressed list and advertises hardcoded share counts, but never sends TransferRequest(dir 1), never handles QueueUpload(43), and never serves file data. The README already declares sharing "not implemented"; the fake responses are the only off-spec behavior actively emitted.

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

7. Indirect connection requests (send ConnectToPeer 18) + CantConnectToPeer reporting.
8. Modern download initiation (QueueUpload 43) and queue tracking (44/51).
9. Distributed-network upkeep (BranchLevel/BranchRoot to server, HaveNoParent(0), Ping, EmbeddedMessage 93, children).
10. Real share serving (compressed SharedFileListResponse, FolderContentsResponse, actual uploads) — declared out of scope.
11. Download resume (non-zero offset on F connections).
