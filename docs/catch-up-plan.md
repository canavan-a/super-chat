# Catching up to the last read position

## What it does
- **Opening a room** lands at the bottom as before, and marks everything read.
  Before that, `openRoom` notes where reading stopped (`Room.readMark`) and
  asks the server how many messages came after it (`Room.newSinceRead`).
- **"↑ N new messages"**, a bubble at the top, shows while that's more than
  zero and the "New messages" line isn't on screen. Its ✕ dismisses it for
  this visit.
- **Tapping the bubble** goes to the "New messages" line, above the first
  message from someone else after `readMark`.
  - **A few behind:** the line is already loaded, so this is just a scroll.
  - **Many behind:** `jumpToRead` swaps the loaded messages for a window
    around it (20 before, 50 after). `hasNewer` is set while the window stops
    short of the newest.
- **In a window:**
  - Scrolling near the bottom pages down 50 at a time (`loadNewer`) until it
    meets the newest.
  - "↓ Jump to latest" stays up the whole time and loads the bottom again
    (`jumpToLatest`).
  - Sending a message also jumps to the bottom first.
  - New lines arriving over WebSocket, push or pull-to-refresh aren't added
    past the window's end, so it never has a hole. They still update
    `lastPos`, the room list preview (`Room.latest`) and notifications.
  - Reactions and receipts go in as usual.
- **Timestamps** on messages and notices from before today include the date
  ("Yesterday 14:05", "Mar 3, 14:05").

## Server
`GET /v1/rooms/:id/unread?after=<pos>` → `{readPos, count}` (see
`docs/protocol.md`, "Reading"). Because `readPos` includes the member's latest
receipt and message, a new install or a second device starts from where the
member actually read.

## Edge cases handled
- **Reconnect** (`resync`) and wipes call `openRoom(key, false)`, which
  catches up without resetting a window or the bubble.
- **A window was left open** when leaving the room: the next open resets to
  the bottom.
- **More than 200 messages behind on a cached room:** `openRoom` used to load
  only the oldest 200 of the gap. It now reloads the bottom.
- **A line held back while a page was in flight:** `settleNewer` keeps
  `hasNewer` until the newest held message reaches `lastPos`. An empty page
  settles it, for when the newest was deleted.
- **The read position was deleted** by retention or a wipe: the window starts
  at the oldest message still there.
- **Join and leave notices** after a window's end aren't drawn below it.
- **Keeping the view still on web:** react-native-web ignores
  `maintainVisibleContentPosition`, so `RoomScreen` shifts the offset by the
  growth in content height while a page goes in.

## Tests
- `server/api/api_test.go` `TestUnreadCount`.
- `app/__tests__/e2e.test.ts` "jumps back to where reading stopped…":
  - a few behind;
  - 120 behind on a new install, using the server read position;
  - a live message held back while windowed;
  - paging down with no gaps.
