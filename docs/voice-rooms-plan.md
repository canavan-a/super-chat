# Voice rooms (WebRTC mesh audio, up to 8 people)

> **Changes since this plan.** The chat server no longer offers a TURN relay:
> the `GET /v1/rooms/:id/turn` endpoint, its `turn.*` NixOS options and the
> "Use the chat server's relay" toggle are gone. Each device uses only the
> STUN/TURN servers on its own list in Settings → Voice, added by hand (a
> STUN/TURN form that tests a server before it can be saved) or from a server
> someone shared in a chat (an `ice` message with an Add card). Mentions of
> the server relay below are historical.

## Context
Super Chat rooms are text-only today. We're giving every chat room a **voice room**: a persistent audio space, like a Discord voice channel.
- People enter and leave whenever they like. It's "live" while anyone is in it.
- There's no ringing and no "call ended": nobody starts or ends anything.
- At most 8 people can be in a voice room at once. The chat room itself can be any size.

Rules:
- **One voice room at a time per device.** It's impossible to be in two. Joining another room's voice means leaving the current one first.
- **A global top bar shows the active voice session** on every screen until you leave. It never blocks navigation. Tapping it opens the voice room screen.
- **The voice room screen** is a tiled grid of cards showing each participant's profile picture.
- **Good loading, reconnecting and buffering states** throughout.
- **Works on the Android app, desktop web and mobile web.**

Transport:
- WebRTC peer-to-peer mesh, with signaling over the existing WebSocket.
- Media goes P2P, or through coturn on the VPS, never through Pangolin.
- Fully E2E: the server relays signaling it can't read or forge, so it can't MITM the DTLS fingerprints.

## Design summary
- **Signaling.** Add a new ephemeral WS message type `rtc`.
  - The server stamps the sender from the socket's subscription, like `typing`, and relays it either to the room or to one member. Nothing is stored.
  - The payload is encrypted with the room's current epoch key and signed with the sender's member key, reusing the scheme in `encryptMessage`, `app/src/crypto/room.ts:97`.
- **Presence lives only on clients.** The server knows nothing about voice rooms.
  - Each session has a random `sid`. A peer is keyed by `(member, sid)`.
  - Occupants broadcast a `beat` every 15 s.
  - When a client subscribes to a room, or the WS reconnects, it broadcasts `probe`, and occupants reply directly with a `beat`. Newcomers learn who's in voice right away instead of waiting up to 15 s.
  - Each `Room` stores the result as `voice` occupants, so the room list and room screen can show "🔊 3".
- **Join protocol.**
  1. The joiner broadcasts `join`.
  2. Each occupant who has fewer than 7 peers replies directly with `here` and creates the offer to the joiner. Existing occupants always make the offer, which avoids both sides offering at once.
  3. An occupant who already has 7 peers replies `full`, and the joiner aborts with "Voice room is full (8/8)".
  4. Because every occupant enforces 7 peers locally, the cap of 8 holds even when two people join at the same moment.
- **One session per device.**
  - `call/engine.ts` is a singleton that holds at most one session.
  - `join()` refuses to run while a session is active.
  - In the UI, tapping Join in room B while in room A shows a confirmation: "Leave voice in A and join B?". Confirming fully finishes `leave()` before calling `join()`.
- **Notifications (nothing is persisted).** When a voice room goes from empty to occupied, i.e. a `join` arrives while `Room.voice` is empty, other members get a local notification: "<name> is in voice · <room>".
  - It goes through the existing notification path and respects the room's mute.
  - Nobody gets notified when someone joins a room that already has people in it.
- **ICE servers are user-configurable, in Settings → Voice.** The list passed to `RTCPeerConnection` merges three sources:
  1. **Your servers:** STUN or TURN entries you add, each `{urls, username?, credential?}`. Stored per device in `settings.ts`.
  2. **The chat server's relay:** if that chat server offers one, it's fetched from `GET /v1/rooms/:id/turn` as short-lived coturn credentials made in shared-secret mode. On by default, with a toggle to turn it off.
  3. **Default STUN:** `stun:stun.l.google.com:19302`, visible in the list and removable, with a note that Google sees your IP when you join voice.
- **Each side uses its own list.** ICE servers are per client, so your peers don't need the same configuration: a relay candidate from your TURN server works for any peer.
- **Connection policy:** try a direct connection, fall back to TURN. A setting, "Relay voice through server (hide IP)", switches to `iceTransportPolicy:'relay'`. It's disabled, with an explanation, unless at least one TURN server is available (one of yours, or the chat server's).
- **Audio settings.**
  - Capture with echo cancellation, noise suppression and auto gain control.
  - Munge the SDP so Opus is mono, constant bitrate, at most 32 kbps.
  - Strip the `ssrc-audio-level` RTP header extension.
  - Detect who's speaking from `getStats()` `audioLevel`, not from that header.

## Wire format (documented in `docs/protocol.md`)
**Client → server:** `{"type":"rtc","room","to"?,"box"}`
- `to` is a member ID; leave it out to broadcast to the room.
- `box` is at most 16 KB, otherwise the server drops it.

**Server → client:** `{"type":"rtc","room","from","box"}`

**Contents of `box`:**
```
box = b64(aead(K_epoch, {"c":b64(inner),"s":b64(Ed25519(me,"SC1-RTC\n"‖inner))}, "sc-rtc|room|epoch|from|to"))
```
It carries an epoch prefix, like messages do.

**`inner`:** `{"v":1,"sid","to_sid"?,"k":"probe|join|here|full|offer|answer|ice|leave|beat","sdp"?,"cand"?,"muted"?,"deaf"?,"ts"}`

**Receiver checks:**
- The signature is valid.
- The decrypted sender matches `from`.
- `ts` is within 60 s.
- `to_sid` matches our own `sid`, or is absent.

## Server changes
- **`server/api/ws.go`**
  - Add `To string` and `Box string` to the incoming struct.
  - Add a `case "rtc"`:
    - Look up the sender's member from `wc.subs`. Ignore the message if the sender isn't subscribed or the box is over 16 KB.
    - Rate-limit with a new per-connection `newLimiter(600, time.Minute)`, since trickled ICE candidates come in bursts.
    - With no `to`, send to the room with `SendRoom(room, msg, member)`. With `to`, use a new `SendMember`.
  - Add `func (h *Hub) SendMember(room, member string, m wsMsg)`. It delivers to every socket subscribed as that member, i.e. all their devices.
  - Update the comment at ws.go:122 that says typing is the only other message a client sends.
- **`server/config/config.go`**
  - Add `TURNURLs []string`, `TURNSecret []byte` and `TURNTTL time.Duration`.
  - Load them from `SUPERCHAT_TURN_URLS` (comma-separated), `SUPERCHAT_TURN_SECRET_FILE` (file read and trimmed) and `SUPERCHAT_TURN_TTL` (default 12h).
- **`server/api/api.go`**
  - Add `signed.GET("/rooms/:id/turn", a.rateLimit(<new turnPerAcct limiter>, byAcct), a.turnCreds)`.
  - The handler calls `a.member(c)`. It returns `{urls, username, credential, ttl}`:
    - `username` is `"<expiry>:<random label>"`. Never put the member ID in it, because coturn logs usernames.
    - `credential` is the standard padded base64 of HMAC-SHA1 over the username.
    - With no secret configured, it returns only `{urls}`, i.e. STUN-only.
- **`module.nix`**
  - Add `turn.urls`, `turn.secretFile` and `turn.ttl` options.
  - Pass the secret with `serviceConfig.LoadCredential = ["turn-secret:${secretFile}"]` and `SUPERCHAT_TURN_SECRET_FILE=%d/turn-secret`, so it never lands in the Nix store.
- **`docs/protocol.md`**
  - Add a new `## Voice rooms` section with the wire format, `inner` kinds, presence and join rules, the cap, and the turn endpoint.
  - Update the WebSocket client→server line (currently around :241).
- **coturn (ops, not in this repo).** Run it on the VPS, outside Pangolin:
  - `use-auth-secret` with the same secret.
  - `denied-peer-ip` for private ranges.
  - `external-ip` set to the VPS address.
  - Open 3478 udp/tcp and the relay port range.

## Client changes (`app/src/`)
- **Dependencies:** add `react-native-webrtc` and `react-native-incall-manager` (speaker or earpiece routing, proximity sensor) for Android.
- **`rtc.ts` / `rtc.web.ts` (new):** a platform shim exporting `RTCPeerConnection`, `mediaDevices` and an `audioRoute` API.
  - On web it uses the browser globals, with a no-op `audioRoute`.
  - In `vite.config.ts`, alias `react-native-webrtc` and `react-native-incall-manager` to stubs, following the existing pattern in `src/stubs/`.
- **`crypto/rtc.ts` (new):** `sealSignal(me, room, epoch, key, to, inner)` and `openSignal(...)`.
  - Modeled on `encryptMessage` and `decryptMessage` in `crypto/room.ts:97/:128`.
  - Reuses `aeadSeal`, `sign`, `verify` and `pubFromMemberId`.
  - Re-exported from `crypto/index.ts`.
- **`api.ts`:** add `api.turn(server, roomId, signer)` using the existing `request()` helper.
- **`store.ts`**
  - `sendRtc(key, to, box)`, which follows the pattern of `sendTyping` (:785).
  - A `case 'rtc'` in `handlePush` (:791), which hands the message to the engine.
  - After a `subscribed` message, broadcast `probe` for each room.
  - Add `Room.voice: Record<member:sid, {member, muted, expires}>`.
    - Updated from `beat`, `join` and `leave`.
    - Expires after 40 s, using the same expiry and `emit()` pattern as `typing` (:840).
    - Fires the "empty → occupied" notification through the existing `onIncoming` / notifications path.
- **`call/engine.ts` (new):** the singleton voice session.
  - **State:** `{roomKey, sid, phase, local stream, muted, deafened, speakerOn, outputDevice, peers: Map<member:sid, {pc, member, muted, deaf, level, state}>}`.
  - **Speaker controls**, described in the "Speaker controls" section below:
    - `setDeafened(bool)`: sound off/on
    - `setSpeakerOn(bool)`: loudspeaker or earpiece, Android app only
    - `setOutputDevice(id)`: output picker, desktop web only
  - **Notifying the UI:** it calls the store's `emit()`, exposed through a `useVoice()` hook that is a selector over the engine state.
  - **`join(roomKey)`:** throws if a session is active. Otherwise it runs the phases in the next section.
  - **Connections:** trickle ICE. Cap at 7 peers, replying `full` beyond that.
  - **Heartbeat:** broadcast a `beat` every 15 s.
  - **Ending a session:**
    - `leave()` broadcasts `leave`, closes every peer connection, stops the tracks and clears the session.
    - Leave automatically on the room's `removed` push, and on epoch changes the user can no longer read.
  - **Speaking indicators:** poll `getStats()` every 300 ms to update `level` for the UI.
  - **SDP munging helpers:** Opus CBR and mono, and stripping the audio-level extension. These are pure functions, so they're unit-testable.
- **`components/VoiceBar.tsx` (new): the global top bar.**
  - **Where it renders:** in `App.tsx`, directly under the existing top bar, on every route except the voice room screen. It shows whenever the engine has a session.
  - **Contents:** a 🔊 icon, the room name, the occupant count, the session timer, and buttons:
    - a **self-mute button**
    - a **sound off** button
    - a **speaker route** button (Android app; an output picker on desktop web)
    - a leave button

    The speaker controls are described in "Speaker controls" below.
  - **On narrow screens:**
    - The room name truncates first, and the timer hides.
    - Mute, sound off and leave are always visible.
    - The speaker route button moves into the voice screen only below about 340 px width.
  - **Self-mute button:**
    - Always visible, never hidden on narrow screens.
    - Shows `mic` when you're live and a red `mic-off` with "Muted" when muted.
    - Tapping it toggles `engine.setMuted()` (sets `track.enabled`, then broadcasts `beat` with `muted`) without navigating.
    - It shares one state with the voice screen and the Android notification action, so all three always match.
    - It has a hit target of at least 44 px and an `accessibilityLabel` of "Mute" or "Unmute".
  - **Tapping:** tapping the bar body calls `navigate({name:'voice', roomKey})`. It never blocks other navigation.
  - **Colour shows state:**
    - normal (`theme.success` accent)
    - joining or reconnecting (amber, with "Connecting…" or "Reconnecting…")
    - unstable connection (amber)
    - error (`theme.danger`, with Retry)
- **`routes.ts` and `App.tsx`**
  - Add a new route `{name:'voice', roomKey}`.
  - Going back from the voice screen only navigates away. **It does not leave the voice room.** Only the Leave button, a kick or a fatal error ends the session.
- **`screens/RoomScreen.tsx`**
  - Add a header action via `onHeaderChange` (:86): `{label:'Voice', icon:'headphones', onPress}`.
    - If you're already in this room's voice, it navigates to the voice screen.
    - If you're in another room's voice, it shows the switch confirmation.
    - Otherwise it joins and then navigates.
  - Add a voice strip under the header whenever `Room.voice` is non-empty: a small stack of avatars plus "3 in voice · Join". At 8 it shows "Full", disabled. If you're already in it, it shows "Open".
- **Room list:** show a 🔊 count badge on rooms whose voice room is occupied, from `Room.voice`.
- **`screens/VoiceScreen.tsx` (new):** the tiled grid.
  - **Cards:** each shows a large `<Avatar roomKey member size>` (`components/Avatar.tsx:16`), the name from `view.names`, a mute badge, a "sound off" badge (`headphone-off`) when that person has sound off, and a speaking ring (a `theme.primary` border animated by `level`). The local user is the first card, labelled "You".
  - **Grid:** 1 column for 1 person, 2 columns for 2–4, 2 columns × 4 rows for 7–8, and `ceil(sqrt(n))` columns on wide web viewports. Cards are square and sized from `useWindowDimensions`.
  - **Controls bar:**
    - mute
    - sound off
    - the speaker route (Android app) or output picker (desktop web)
    - leave, in `theme.danger`
  - **Opening it without being in the voice room:** you can only get here when you're in a session, but if it's opened anyway (for example a stale route), show the occupants read-only with a Join button.
  - **Styling:** the `useTheme()` + `makeStyles(theme)` pattern.
- **`components/Icon.tsx`:** add `headphones`, `headphone-off`, `phone-off`, `mic`, `mic-off`, `volume-2`, `volume-x` and `speaker` from lucide.
- **`settings.ts`:** add the voice settings.
  - `iceServers: {urls: string, username?: string, credential?: string}[]`, defaulting to `[{urls:'stun:stun.l.google.com:19302'}]`.
  - `useServerRelay: boolean`, default `true`.
  - `relayOnlyVoice: boolean`, default `false`.
  - **User-added ICE servers and their credentials never leave the device.** They're never put in `rtc` signals, synced through the vault, or included in exports. Only the relay *candidate* (the relay's IP and port) appears in SDP, which is how WebRTC works.
  - In the Add server form, note that peers will see the relay's IP address, so pick a relay that isn't tied to your identity if that matters to you. Recommend `turns:` so the TURN username isn't sent in plaintext.
  - TURN passwords are stored in the same AsyncStorage as the other settings. They only grant relay use and can't decrypt media, since media is DTLS-SRTP end to end. The settings screen says so.
- **`call/iceConfig.ts` (new):** a pure function, `buildIceConfig(settings, serverTurn | null)`, which returns `RTCConfiguration`. It merges the three sources, removes duplicates and applies the policy, so it can be unit-tested.
- **`screens/SettingsScreen.tsx`: a new "Voice" section.** Follow the existing Servers section's add/remove list pattern.
  - **The server list is fully editable:**
    - Each row shows a STUN or TURN tag, the URL and the username (never the password), with Edit and Delete buttons.
    - Tapping a row or Edit opens the same form as "Add server", prefilled. The password field is blank and keeps the old password unless you type a new one.
    - **"Delete all"** (with a confirmation) empties the list, including Google STUN. An empty list is a valid state.
    - **"Reset to default"** restores just Google STUN.
    - Under the list, a status line summarizes your setup: "TURN configured ✓", "STUN only: some connections will fail", or "No servers: voice only works on the same network". It takes the server-relay toggle into account.
  - **"Add server" / edit form:**
    - URL, validated to the `stun:`, `turn:` or `turns:` scheme, with an optional `?transport=` suffix.
    - Username and password fields, shown only for `turn:` and `turns:` URLs.
  - **"Test" button on each row:**
    - It creates a throwaway `RTCPeerConnection` with only that server and gathers candidates for up to 5 s.
    - It reports ✓ reachable (a `srflx` candidate for STUN, a `relay` candidate for TURN), ✗ unreachable, or "auth failed" when TURN gathers no relay candidate.
    - Put the logic in `call/testIce.ts`, which works on both web and native through the `rtc` shim.
  - **Toggles:** "Use chat server's relay when available" and "Relay all voice (hide IP)".
  - **The Google STUN row** shows its privacy note.
- **`call/iceConfig.ts` also exports `iceCoverage(config)`,** which returns `'none' | 'stun-only' | 'turn'`. The status line, the join popup and the in-call warning (next section) all use it.

## Fast joins (pre-warming)
While a room's chat is open and someone is in its voice, the engine gets ready so Join is near instant:
- **Relay credentials are fetched ahead and cached** until shortly before they expire, so joining makes no network round trip for them.
- **One peer connection per person in voice is kept gathering ICE candidates** (`iceCandidatePoolSize`). Joining takes these instead of starting from scratch.
- **The microphone is never touched before Join.**
- **Inside voice, one warmed connection is kept for the next joiner**, so occupants answer a join with an offer immediately.
- **Joining uses presence to skip waiting:** with people already there, their cards appear connecting at once; with nobody, you're live at once.
- **Warmed connections are closed** when the chat closes, when voice empties, or after 5 minutes unused.
- Rooms subscribed to after the socket is up (just created or joined) send their own `probe`, so presence is known right away.

## Speaker controls
There are two separate controls. Both live in `VoiceBar`, the voice screen's controls bar and, on Android, the ongoing notification. All of them share engine state, so every place shows the same value.

**1. Sound off (deafen)**, available everywhere:
- **What it does:** silences everyone else.
  - On native it sets every remote audio track to `enabled=false`.
  - On web it sets `muted` on the hidden `<audio>` elements in `RemoteAudio.web.tsx`.
- **Turning sound off also mutes your mic,** like Discord's deafen. Turning sound back on restores whatever mute state you had before.
- **Icons:** `volume-2` when sound is on, a red `volume-x` with the label "Sound off" when off.
- **Others see it:** the `beat` broadcasts `deaf`, and other people's tiles for you show a `headphone-off` badge.
- **New joiners:** a peer that joins while your sound is off is silenced from the start.

**2. Speaker route**, which depends on the platform:
- **Android app:** a loudspeaker/earpiece toggle using `InCallManager.setForceSpeakerphoneOn`.
  - It defaults to loudspeaker, which suits a voice room.
  - With wired or Bluetooth headphones connected, InCallManager routes audio to them automatically. The button then shows "Headset" and is disabled.
  - Listen for InCallManager's `WiredHeadset` and Bluetooth events to update this.
  - InCallManager's proximity sensor turns the screen off while on earpiece.
- **Desktop web:** a `speaker` button opens an output device picker.
  - It uses `navigator.mediaDevices.selectAudioOutput()` where available, otherwise `enumerateDevices()` plus `HTMLMediaElement.setSinkId()` on each `<audio>` element.
  - The button is hidden in browsers that support neither.
  - The chosen device is remembered for the session.
- **Mobile web:** no speaker route button, because browsers can't pick the earpiece. Sound off is still available.

## Loading, reconnecting and buffering states
These all live in `call/engine.ts` as explicit state. They're rendered by `VoiceScreen` and summarized in `VoiceBar`.

**Joining** (`engine.phase`). Each step shows its own label under a pulsing avatar of you:
1. `mic`: "Allow microphone…"
   - If permission is denied, show an explanation and a button. On Android it calls `Linking.openSettings()`; on web it shows instructions for the browser's site-permission UI.
2. `config`: "Preparing…". Fetch the chat server's relay credentials if that's enabled, then compute `buildIceConfig` and `iceCoverage`.
   - If the fetch fails, carry on without the server relay. Coverage is computed from what's actually available.
   - **Coverage `none` shows a popup before joining:** "No STUN/TURN servers configured. Voice will only connect to people on the same network as you." It has three buttons: **Open voice settings**, **Join anyway** and **Cancel**. The microphone isn't opened until you choose Join anyway.
   - **Coverage `stun-only`** joins normally, with the in-call warning below.
3. `finding`: "Joining voice…"
   - Broadcast `join` and wait up to 1.5 s for `here` or `full` replies.
   - If nobody answers, go straight to `live` with "You're the only one here".
4. `connecting`: tiles appear immediately for everyone in `Room.voice`. Each one is a skeleton card (dimmed avatar plus spinner) until its peer connects.
5. `live`: shown once at least one peer is connected, or immediately if you're alone.
- **Overall timeout:** if no peer connects within 20 s of the `here` replies, show "Couldn't connect to voice" with Retry and Leave. Retry re-runs from step 2.
- **Full:** "Voice room is full (8/8)", with a Close button.

**Per-peer tile states** (`peer.state`, derived from `pc.connectionState` and stats):
- `connecting`: skeleton card, "Connecting…"
- `live`: normal card with the speaking ring
- `weak`: still connected, but packet loss is above 10% or jitter is above 100 ms for 3 s or more. Show a small "weak connection" badge with signal bars.
- `stalled`: connected, but `inbound-rtp.packetsReceived` hasn't increased for 2 s or more. Show the dimmed avatar plus "Buffering…" spinner overlay. WebRTC's jitter buffer and packet-loss concealment carry short gaps, so this only shows on real stalls.
- `reconnecting`: `connectionState` is `disconnected` or `failed`. Show a dimmed card with "Reconnecting…".
  - WebRTC often recovers on its own within about 5 s from `disconnected`.
  - On `failed`, or after 5 s of `disconnected`, the original offerer calls `restartIce()` and sends a new offer. It tries up to 3 times, with 2 s, 4 s and 8 s backoff.
- `lost`: retries are exhausted, or there has been no heartbeat for 40 s. Remove the tile and show a toast: "<name> dropped".
- **Grace period:** a tile stays in place through `stalled` and `reconnecting`, so the grid doesn't jump around.

**Local connectivity** (shown as a banner on the voice screen and as the bar's colour and label):
- **Signaling down:** the WS is closed (the store's `conns` status). Show "Reconnecting to server…". Media that's already connected keeps flowing.
  - When the WS re-subscribes, re-broadcast `join` and `beat` with the same `sid`. Peers treat this as the same session, not a new join.
- **Our own network dropped:** if every peer goes `reconnecting` or `stalled` at once, show "Your connection is unstable" and suppress the per-tile badges. On web, also listen for `online`/`offline` events.
  - When the network changes (e.g. Wi-Fi to cellular), trigger `restartIce()` on every peer as soon as the WS reconnects, instead of waiting for each to fail separately.
- **Leaving:** the bar shows "Leaving…" while the `leave` broadcast is sent and connections close (at most about 500 ms), then it disappears.

**Relay warnings and diagnosing connection failures:**
- **STUN-only warning.** While coverage is `stun-only`, the voice screen shows a persistent amber banner: "No TURN relay configured. You may not be able to connect to some people, especially on mobile data or strict networks. Add a TURN server in Settings → Voice." It links to the settings.
  - The banner can be dismissed for the current session only; it comes back on the next join.
  - `VoiceBar` shows a small ⚠ next to the room name. Tapping it opens the voice screen.
- **Detecting ICE failures.** For each peer, collect:
  - `icecandidateerror` events, with `errorCode` and `url`.
    - 701 means a STUN or TURN server couldn't be reached.
    - 401 or 403 means TURN credentials were rejected.
  - The local candidate types gathered (`host`, `srflx`, `relay`), from `getStats()` `local-candidate` entries.
  - Whether the peer ever reached `connected`.
- **`call/diagnose.ts` (new):** a pure function that turns those facts into one diagnosis, checking in this order:
  1. TURN auth error: "Your TURN server <url> rejected the username or password."
  2. Server unreachable (701, or a configured server produced no candidates): "Couldn't reach <url>. Check the address, port and transport, and that it's online."
  3. Only `host` candidates: "No public address found. Your STUN servers aren't working, or you have none."
  4. `srflx` but no `relay`, and the connection failed: "A direct connection was blocked by NAT or a firewall (yours or theirs). Add a TURN server, or check your NAT or firewall settings."
  5. `relay` present but the connection still failed: "Couldn't connect to <name>. Their network or relay setup may be the problem."
- **Where the diagnosis appears:**
  - The peer's tile shows "Can't connect" with an ⓘ that opens a sheet. The sheet shows the diagnosis plus **Open voice settings** and **Retry** buttons.
  - If every peer fails, or the 20 s join timeout hits, the "Couldn't connect to voice" screen shows the diagnosis directly.
- **Platform note:** `react-native-webrtc` may not fire `icecandidateerror`. The diagnosis still works from candidate types alone, which is why the checks fall through in that order.
- **Settings Test button:** it uses the same `icecandidateerror` and candidate-type logic as `diagnose.ts`, so Settings and calls report errors the same way.

**Stats polling:** one `getStats()` loop every 300 ms per peer feeds the speaking level, `weak` and `stalled`. Put this in a pure `call/quality.ts` (stats snapshot in, quality and level out) so it can be unit tested.

## Web and mobile support
The same engine and UI run everywhere. Only `rtc.ts` / `rtc.web.ts` and small audio components differ by platform.

| | Android app | Desktop web (Chrome/Firefox/Safari) | Mobile web (Android Chrome, iOS Safari) |
|---|---|---|---|
| WebRTC | `react-native-webrtc` | browser | browser |
| Remote audio playback | automatic | hidden `<audio autoplay>` per peer | same as desktop web; `playsinline` |
| Sound off (deafen) | remote tracks `enabled=false` | `<audio>.muted` | `<audio>.muted` |
| Speaker route | loudspeaker/earpiece toggle via `InCallManager.setForceSpeakerphoneOn` | output device picker via `setSinkId`/`selectAudioOutput` where supported, otherwise hidden | hidden (the OS routes audio) |
| Keep alive in background | foreground service, type `microphone` | n/a | best effort; show a "keep this tab open" hint |
| Screen awake | InCallManager (proximity) | `navigator.wakeLock`, best effort | `navigator.wakeLock`, best effort |
| Mic permission | `PermissionsAndroid` | `getUserMedia` prompt | `getUserMedia` prompt |

Implementation notes:
- **`call/RemoteAudio.web.tsx` / `call/RemoteAudio.tsx`:** on web this renders one hidden `<audio>` element per peer with `srcObject = stream`. The native version returns `null`.
  - Mount it in `App.tsx`, not in `VoiceScreen`, so audio keeps playing while you browse other screens.
- **Web autoplay:** browsers only allow audio to start after a user action. The Join tap counts as one, so call `play()` from that tap's handler path.
  - If `play()` is rejected, the bar and voice screen show "Tap to enable audio".
- **Secure origin:** `getUserMedia` needs HTTPS, which Pangolin already provides. On plain `http://` (other than localhost), show an error explaining why voice is unavailable instead of failing silently.
- **Responsive layout:**
  - The grid uses `useWindowDimensions`. On narrow phones, both web and native, it uses 2 columns.
  - The controls bar is pinned to the bottom, with safe-area padding on native and `env(safe-area-inset-bottom)` on web.
  - `VoiceBar` stays a single line on narrow screens: the room name truncates, and the mute and leave buttons stay visible.
- **iOS Safari:** it's mobile web only, since there's no native iOS app. It suspends background tabs, so voice stops when the tab is backgrounded. Detect `visibilitychange`, show the hint above, and recover with an ICE restart when the tab is visible again.

## Android
- **`AndroidManifest.xml`:**
  - Add `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT` and `FOREGROUND_SERVICE_MICROPHONE`.
  - Change the Notifee service's `foregroundServiceType` to `dataSync|microphone`.
- **Keeping voice alive in the background:** while in voice, `BackgroundMonitorService` updates its ongoing notification with "In voice · <room>", Mute, Sound off and Leave actions, and the `MICROPHONE` foreground service type.
  - Android 14 requires this to start while the app is in the foreground. Joining always happens from the UI, so that's fine.
  - Revert to `dataSync` only when you leave.
- The WebSocket already stays alive in the background through this service, so presence and signaling keep working.

## Out of scope for v1
- Video.
- An SFU.
- Ringing or incoming-call UI (not needed for the voice-room model).
- Push notifications when no device has a live WebSocket.
- Native iOS app (iOS works through mobile web).

## Tests
- **Go (`server/api/api_test.go`):** add the first WebSocket tests.
  - Helpers: dial `/v1/ws`, sign the challenge with the `SC1-WS` domain, and subscribe two or three users from `e.createRoom` / `r.join`.
  - Check that:
    - A directed `rtc` reaches only its target, on every one of the target's sockets.
    - A broadcast `rtc` reaches everyone except the sender.
    - `from` is stamped by the server, even if the client sends a fake one.
    - An unsubscribed sender, or a box over 16 KB, is dropped.
    - Rate limiting works.
  - `turnCreds`: it returns 404 for non-members; the HMAC matches a recomputation; the expiry equals now plus the TTL; with no secret it returns STUN-only.
- **Jest:**
  - `crypto/rtc`: round-trip; reject a tampered box, the wrong room, the wrong `to`, a stale `ts`, and a forged sender.
  - The SDP munging helpers.
  - `buildIceConfig`:
    - merges and de-duplicates the three sources
    - skips the server relay when `useServerRelay` is off or the fetch failed
    - relay-only with no TURN server leaves the policy at `all`
    - the URL validation accepts and rejects the right forms
  - `iceCoverage`: an empty list with the server relay off or unavailable gives `none`; Google STUN only gives `stun-only`; any TURN, yours or the chat server's, gives `turn`.
  - `diagnose.ts`: one case for each diagnosis, including with no `icecandidateerror` events (the native fallback).
  - Settings list editing: edit keeps the old password when the field is left blank; Delete all leaves an empty list; Reset to default restores Google STUN.
  - `call/quality.ts`: stats sequences map to `live`, `weak`, `stalled`, and the right speaking level.
  - Engine logic with a fake `RTCPeerConnection`:
    - join and cap: who makes the offer, `full` at 7 peers, a simultaneous join
    - **calling `join()` while a session is active throws**, and the switch flow leaves before joining
    - `setMuted()` disables the local track and broadcasts a `beat` with `muted`, and peers' `muted` updates
    - `setDeafened(true)` silences every remote track and forces mute on; `setDeafened(false)` restores the previous mute state; the `beat` carries `deaf`
    - peers who join while you have sound off arrive silenced too
    - the speaker route resets to loudspeaker on join, and is reported as `headset` when one is connected
    - `probe` gets direct `beat` replies; `Room.voice` expiry
    - the empty → occupied notification fires once
    - state transitions:
      - `connecting` → `live`
      - `disconnected` → `reconnecting` → recovered
      - `failed` → 3 ICE restarts → `lost`
      - the 20 s join timeout
      - a WS reconnect re-broadcasts with the same `sid`
- **E2E (`__tests__/e2e.test.ts`, `E2E=1`):** two store clients against the real server exchange a sealed `rtc` message, and a third client that isn't the target doesn't receive it. A `probe` from a late subscriber gets `beat` replies.

## Verification
1. Run `cd server && go test ./...` and `cd app && npm test && E2E=1 npm test`.
2. Run `npm run web` in two browser profiles, both joined to the same room.
   - A joins voice: B sees the 🔊 badge in the room list, the voice strip, and a notification.
   - B joins: both hear audio, and the mute badge and speaking ring update.
3. **Global bar:**
   - While in voice, navigate to other rooms and to settings. The bar stays on every screen, audio keeps playing, and tapping the bar returns to the voice screen.
   - Back from the voice screen doesn't leave.
   - Sound off from the bar while on another screen works: you hear no one, the mic mutes too, and the voice screen matches.
   - Muting from the bar while on another screen works: the icon turns red, the other side sees your mute badge and stops hearing you, and the voice screen and Android notification show muted too.
   - Tapping Join in a second room shows the switch prompt. Confirming leaves the first room's voice (the other side sees you leave) before joining the second. It's never possible to be in both.
4. Open 8 tabs or profiles in the same voice room and confirm the 9th gets "Voice room is full".
5. With an Android device and a browser:
   - Check that voice keeps going with the screen off or the app in the background, and that the ongoing notification's Mute and Leave actions work.
   - Speaker toggle: switching moves audio between loudspeaker and earpiece. Plugging in wired or Bluetooth headphones routes to them, and the button shows "Headset".
   - Sound off from the bar, the voice screen and the notification:
     - you hear no one, and your mic is muted
     - the other side sees both badges
     - turning sound back on restores your previous mute state
   - Desktop Chrome: the output picker moves voice audio to another device.
6. **Settings → Voice:**
   - Add your coturn as `turns:` with static credentials and press Test. It should show ✓ relay. A wrong password should show "auth failed".
   - Remove Google STUN, turn off the server relay, then join voice. `chrome://webrtc-internals` should show only your servers in use.
   - Do the same on Android.
   - Edit a TURN entry's URL. Delete all, then try to join voice: you should get the "No STUN/TURN servers" popup, with Open settings, Join anyway and Cancel all working.
   - With Google STUN only and the server relay off: join voice and check that the amber STUN-only banner and the ⚠ in the bar appear.
   - With a TURN entry that has the wrong password: put one side on cellular and join. The tile should end at "Can't connect", with the TURN-auth diagnosis.
   - With an unreachable STUN URL: you should get the "Couldn't reach" diagnosis.
7. Put the Android device on cellular data and the browser on home Wi-Fi with TURN configured. Turn on relay-only and confirm in `chrome://webrtc-internals` that the selected candidate pair is `relay`.
8. Kick a participant while they're in voice: their session ends and the bar disappears, and the rest continue.
9. **Loading and buffering states:**
   - Use Chrome DevTools network throttling (offline, then back online) on one tab:
     - The other tabs show `stalled`, then `reconnecting`, then `live`.
     - The throttled tab's bar turns amber.
   - Switch the phone between Wi-Fi and cellular and confirm it recovers with an ICE restart.
   - Kill the server process mid-session:
     - Audio continues.
     - "Reconnecting to server…" shows.
     - When the server comes back, there are no duplicate tiles.
   - Deny mic permission and block TURN to see the error and fallback screens.
10. **Browser and device test matrix:** test between each of these:
   - desktop Chrome, Firefox and Safari
   - Android Chrome (mobile web)
   - iOS Safari (mobile web)
   - the Android app

   For each, check autoplay, the output picker or speaker toggle, the narrow layout and the bar, and backgrounding.
