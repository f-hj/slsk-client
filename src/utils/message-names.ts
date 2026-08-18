/**
 * Names of the protocol messages, so the debug output reads as the protocol documentation does
 * instead of as bare numbers. Names follow the ones used by the reference implementations, and
 * cover far more codes than this client handles: what matters in a log is knowing what a peer
 * or the server sent, whether or not we do anything with it.
 */

/** Messages of the connection to the slsk server, code is an uint32 */
export const SERVER_MESSAGES: Record<number, string> = {
  1: 'Login',
  2: 'SetWaitPort',
  3: 'GetPeerAddress',
  5: 'WatchUser',
  6: 'UnwatchUser',
  7: 'GetUserStatus',
  11: 'IgnoreUser',
  12: 'UnignoreUser',
  13: 'SayChatroom',
  14: 'JoinRoom',
  15: 'LeaveRoom',
  16: 'UserJoinedRoom',
  17: 'UserLeftRoom',
  18: 'ConnectToPeer',
  22: 'MessageUser',
  23: 'MessageAcked',
  25: 'FileSearchRoom',
  26: 'FileSearch',
  28: 'SetStatus',
  32: 'ServerPing',
  33: 'SendConnectToken',
  34: 'SendDownloadSpeed',
  35: 'SharedFoldersFiles',
  36: 'GetUserStats',
  40: 'UploadSlotsFull',
  41: 'Relogged',
  42: 'UserSearch',
  50: 'SimilarRecommendations',
  51: 'AddThingILike',
  52: 'RemoveThingILike',
  54: 'Recommendations',
  55: 'MyRecommendations',
  56: 'GlobalRecommendations',
  57: 'UserInterests',
  58: 'AdminCommand',
  59: 'PlaceInLineRequest',
  60: 'PlaceInLineResponse',
  62: 'RoomAdded',
  63: 'RoomRemoved',
  64: 'RoomList',
  65: 'ExactFileSearch',
  66: 'AdminMessage',
  67: 'GlobalUserList',
  68: 'TunneledMessage',
  69: 'PrivilegedUsers',
  71: 'HaveNoParent',
  73: 'ParentIP',
  83: 'ParentMinSpeed',
  84: 'ParentSpeedRatio',
  86: 'ParentInactivityTimeout',
  87: 'SearchInactivityTimeout',
  88: 'MinParentsInCache',
  90: 'DistribPingInterval',
  91: 'AddToPrivileged',
  92: 'CheckPrivileges',
  93: 'EmbeddedMessage',
  100: 'AcceptChildren',
  102: 'PossibleParents',
  103: 'WishlistSearch',
  104: 'WishlistInterval',
  110: 'SimilarUsers',
  111: 'ItemRecommendations',
  112: 'ItemSimilarUsers',
  113: 'RoomTickers',
  114: 'RoomTickerAdded',
  115: 'RoomTickerRemoved',
  116: 'SetRoomTicker',
  117: 'AddThingIHate',
  118: 'RemoveThingIHate',
  120: 'RoomSearch',
  121: 'SendUploadSpeed',
  122: 'UserPrivileged',
  123: 'GivePrivileges',
  124: 'NotifyPrivileges',
  125: 'AckNotifyPrivileges',
  126: 'BranchLevel',
  127: 'BranchRoot',
  129: 'ChildDepth',
  130: 'ResetDistributed',
  133: 'RoomMembers',
  134: 'AddRoomMember',
  135: 'RemoveRoomMember',
  136: 'CancelRoomMembership',
  137: 'CancelRoomOwnership',
  139: 'RoomMembershipGranted',
  140: 'RoomMembershipRevoked',
  141: 'EnableRoomInvitations',
  142: 'ChangePassword',
  143: 'AddRoomOperator',
  144: 'RemoveRoomOperator',
  145: 'RoomOperatorshipGranted',
  146: 'RoomOperatorshipRevoked',
  148: 'RoomOperators',
  149: 'MessageUsers',
  150: 'JoinGlobalRoom',
  151: 'LeaveGlobalRoom',
  152: 'GlobalRoomMessage',
  153: 'RelatedSearch',
  160: 'ExcludedSearchPhrases',
  1001: 'CantConnectToPeer',
  1003: 'CantCreateRoom'
}

/** First message of any peer connection, whatever its type, code is a single byte */
export const INIT_MESSAGES: Record<number, string> = {
  0: 'PierceFireWall',
  1: 'PeerInit'
}

/** Messages of a peer connection (type P), code is an uint32 */
export const PEER_MESSAGES: Record<number, string> = {
  4: 'SharedFileListRequest',
  5: 'SharedFileListResponse',
  8: 'FileSearchRequest',
  9: 'FileSearchResponse',
  15: 'UserInfoRequest',
  16: 'UserInfoResponse',
  36: 'FolderContentsRequest',
  37: 'FolderContentsResponse',
  40: 'TransferRequest',
  41: 'TransferResponse',
  42: 'PlaceholdUpload',
  43: 'QueueUpload',
  44: 'PlaceInQueueResponse',
  46: 'UploadFailed',
  50: 'UploadDenied',
  51: 'PlaceInQueueRequest',
  52: 'UploadQueueNotification'
}

/** Messages of a distributed connection (type D), code is a single byte */
export const DISTRIBUTED_MESSAGES: Record<number, string> = {
  0: 'DistribPing',
  3: 'DistribSearch',
  4: 'DistribBranchLevel',
  5: 'DistribBranchRoot',
  7: 'DistribChildDepth',
  93: 'DistribEmbeddedMessage'
}

/** `QueueUpload(43)` for a message of the table, `unknown(99)` for anything else */
export function nameOf (names: Record<number, string>, code: number): string {
  return `${names[code] ?? 'unknown'}(${code})`
}
