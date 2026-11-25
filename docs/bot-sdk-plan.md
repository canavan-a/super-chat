# Bot SDK (Go)

## Context
A bot is a process with its own Super Chat account. It joins rooms through
invite links, reads messages as they arrive, and acts on the ones that tag it.
We ship it as a **Go SDK**: anyone builds their own bot by importing the
module, registering handlers and calling `Run()`. Each bot owns its build and
deployment; nothing ties it to Nix. A stock bot (`cmd/superchat-bot`) is the
SDK with only the core commands.

Rules:
- **Every room is treated the same.** There's no DM-vs-group distinction.
- **You talk to a bot only by @mentioning it.** In a message, a mention is
  sent as `<@memberId>`, and each bot acts only on its own ID, so several bots
  can share a chat. There are no slash commands.
- **One global admin password per bot.** Saying it in a chat makes the sender
  an admin of the bot in that room. Typing it into a group is up to the
  user.
- **One name and one picture, everywhere.** They're set from chat and
  re-published to every room. On `init` the bot gets a random friendly name
  from a fixed list of 50 common first names.
- **Kicks are handled.** Removal from a room, live or while offline, cleans up
  that room and fires a hook.
- **Voice is send-only.** The bot can count who's in voice, join, leave and
  push its own audio. It never receives anyone else's audio.

## Layout

```
go.work                  local dev: server, shared and bot resolve to each other
shared/                  github.com/canavan-a/super-chat/shared (backend code used by the server and the bot)
  proto/                 DONE, moved from server/proto: IDs, signatures, room-log state machine
  crypto/                NEW: client half of docs/protocol.md (section 1)
  wire/                  NEW: API request/response structs, WebSocket message types, limits
server/                  `module main` (nobody imports it); requires shared via `replace => ../shared`
bot/                     NEW, its own go.mod: github.com/canavan-a/super-chat/bot
  store/                 on-disk state
  runtime/               connections, ingest, rotation, removal
  voice/                 send-only WebRTC mesh peer (pion/webrtc)
  audio/                 Source: Ogg/Opus reader; PCM encoder behind `-tags opus`
  bot.go, ctx.go, ...    the public API (package bot)
  core/                  the core commands, registered like any other command
  names.go               the 50 default names
  cmd/superchat-bot/     stock bot: bot.New + core + CLI
```

- **Dependencies:** `shared` uses only the standard library and
  `golang.org/x/crypto`, so people who import the bot never pull in the
  server's SQLite, FCM and similar dependencies.
- **Tags:** releases are tagged `shared/vX.Y.Z` and `bot/vX.Y.Z`.
- **No `replace` in `bot/go.mod`:** it must require a tagged `shared`,
  because people importing the bot need a real version to resolve. Locally,
  `go.work` covers it.
- **The server uses `replace`:** that's harmless because nobody imports the
  server. It also keeps the NixOS module's build working, since it runs
  `cd ${self}/server && go build`.
- **Shared wire types:** the server's handlers move onto the `wire` types
  bit by bit. The server and the bot then compile against one definition of
  each request, response and WebSocket message, where today the server builds
  untyped `wsMsg{…}` maps.

## 1. Protocol port (`shared/crypto`)
This is the client half of `docs/protocol.md`, written in Go. Where the doc
and the code disagree, follow `app/src/crypto/*.ts`. The doc is missing
`edit` messages and `<@id>` mentions; fix it as part of this work.

- **Identity:** 32-byte entropy, BIP-39 phrase, and per-room
  `edSeed`/`xPriv` through HKDF.
- **Encryption primitives:** `seal`/`unseal` (X25519 + HKDF +
  XChaCha20-Poly1305) and `aead`.
- **Epochs:** open envelopes, check the commit, make new epochs with
  envelopes for every member, and put a snapshot in `enc`.
- **Events:** sign, chain (`seq`/`prev`/hash), and encrypt `enc`, for
  `join`, `epoch`, `profile` and `leave`.
- **Messages:** encrypt and decrypt the inner payload and its signature.
  Content types are `text`, `file`, `edit`, `reaction` and `receipt`.
- **Invites:** parse both link forms (`/i/<id>#<secret>` and
  `superchat://join?...`), derive the invite seed, build the join proof, and
  decrypt the preview.
- **Blobs:** encrypt and decrypt with `sc-blob`, upload and download. Avatars
  use the `PUT /avatar` flow and `enc.avatar = {blob, key, at}`.
- **HTTP:** signed requests (`X-SC-*` headers, the `SC1` signing string).
  On a 409 conflict, refetch and retry.
- **WebSocket:** answer the challenge, send `sub` with signatures, handle
  `event`, `message`, `deleted`, `removed` and `rtc`, and reconnect with
  backoff.
- **RTC boxes:** seal and open `rtc` boxes (`sc-rtc|…`), for voice.

**Interop is a hard requirement.** Add a script under `tools/` that exports
test vectors from the TS code: phrase → member IDs, a sealed envelope, a
message ciphertext, an rtc box, a join proof and a blob. Go tests must
reproduce and open each one, the same way as
`shared/proto/interop_test.go` + `testdata/ts-log.json`, which the app's
`__tests__/crypto.test.ts` writes.

## 2. Storage (`bot/store`)
Use a pure-Go SQLite (`modernc.org/sqlite`, so there's no cgo) in `DataDir`.

- **`account`:** entropy, the scrypt hash of the admin password, display
  name, and the current picture bytes and their `at`.
  - The entropy file is 0600.
  - `SUPERCHAT_BOT_ENTROPY_FILE` can point to it somewhere else, for secrets
    managers.
- **`rooms`:** id, server, the event log (raw signed events), epoch keys, the
  last message position processed, and the bot's avatar blob in that room.
- **`admins`:** `(room, member)`.
- **`plugin_kv`:** a small key-value store per room for plugins.
  - It's exposed as `ctx.Store()`.
  - Plugins are free to use their own storage instead.

## 3. Runtime (`bot/runtime`)
For each server, the runtime runs one WebSocket subscribed to every room the
bot is in on that server.

- **Catch-up:** on start and on every reconnect, fetch new events, then
  `GET messages?after=<last position>`, before handling live traffic. On a
  restart, nothing is replayed and nothing is missed.
- **Ingest:**
  - Apply events through `proto.State.Apply`.
  - Decrypt and verify messages, then drop the bot's own messages and
    messages from epochs it can't read.
  - Save the position after each message has been handled.
- **Joining** (`Join(link)`):
  - Preview the invite, then post `join + epoch + profile` in one request.
    The joiner rotates the key itself.
  - Upload the avatar, subscribe to the room, then fire `OnJoin`.
- **Rotation, the same as `maybeRotate` in `store.ts`:**
  - Rotate when `pendingRotation` is set, i.e. after someone leaves.
  - Force a rotation after 7 days only if the bot is an admin of the room.
  - After every epoch the bot didn't create, re-publish its `profile`. The
    avatar key travels in the profile.
- **Profile everywhere:** `SetName` and `SetPicture` go through every room,
  one at a time, retrying failures. Each room gets its own avatar blob.
- **Removal:** these all go through one `removeRoom(room, reason)`:
  - a WebSocket `removed` message;
  - a `kick` event that names the bot;
  - a 403 "not a member" on a signed request;
  - the bot's own `leave`.

  It unsubscribes, ends any voice in that room, deletes the room's keys, log
  and admins, fires `OnRemoved`, and never rejoins on its own.
- **Error handling:** a panic in a handler is recovered and logged. Replies
  are rate-limited per room so one buggy plugin can't flood a chat.

## 4. Public API (`package bot`)

```go
b, err := bot.New(bot.Config{
    DataDir:    "/var/lib/mybot",
    Servers:    []string{"https://chat.superbadger.io"},
    ICEServers: []webrtc.ICEServer{...}, // voice only
    Logger:     slog.Default(),
})
core.Register(b) // help, login, name, picture, join, leave (+ voice join/leave/who)

b.Command("roll", bot.Anyone, func(c *bot.Ctx) error { return c.Reply("4") })
b.Command("deploy", bot.Admin, deploy)

b.OnMessage(fn)                 // every message, whether it tags the bot or not
b.OnJoin(fn); b.OnRemoved(fn)
b.OnVoicePresence(fn)           // (ctx, before, after []VoiceSession)
b.OnVoiceJoined(fn); b.OnVoiceLeft(fn)
b.OnVoicePeerJoined(fn); b.OnVoicePeerLeft(fn)

err = b.Run(ctx)                // blocks; stops cleanly when ctx is cancelled
```

- **How a command is found:** the message has to contain the bot's own
  `<@id>`. The first word after it is the command, and the rest is
  `c.Args`. An unknown word goes to the fallback (`b.Unknown(fn)`), which by
  default suggests `help`.
- **Edits don't run commands again.** Edits and reactions reach `OnMessage`,
  but they never trigger a command.
- **`Ctx` fields:** `Room` (id, name, members), `Sender` (id, name,
  `IsAdmin`), `Message` (raw content, `Attachments`, `Mentions()`) and `Args`.
- **`Ctx` methods:** `Reply` (sends with `replyTo`), `Send`, `SendFile`,
  `React`, `Download(FileRef)` and `Store()`.
- **Bot methods:** `b.Join(link)`, `b.Leave(room)`, `b.Rooms()`,
  `b.SetName`, `b.SetPicture`, `b.Voice`.

### Core commands
| Mention + word | Who | Does |
|---|---|---|
| `help` | anyone | lists the commands this sender can use |
| `login <password>` | anyone | the sender becomes an admin in this room. Wrong guesses back off per member (1 s, 2 s, 4 s, …) |
| `name <name>` | admin | renames the bot in every room |
| `picture` (image attached) | admin | sets the picture in every room. The image is resized and re-encoded as JPEG, the same as the app's avatars |
| `join <link>` | admin | joins another chat |
| `leave` | admin | posts `leave` and runs `removeRoom` |
| `voice join` / `voice leave` / `voice who` | admin, admin, anyone | wrappers over `b.Voice` |

An admin is per room because member IDs are per room: logging in in one chat
does nothing in another. An admin who leaves or is kicked from a room loses
admin there.

## 5. Voice (`bot/voice`, send-only)

```go
b.Voice.Presence(room) []VoiceSession   // {Member, Name, Muted, Deaf}; works without joining
call, err := b.Voice.Join(room)         // ErrFull at 8
call.Play(src audio.Source) *Playback   // pb.Stop(), pb.Done()
call.SetMuted(bool)
call.Leave()
```

- **Presence:** after subscribing, send `probe`, then track the `beat`s that
  come back. A session not heard from for 40 s is gone. This is what the app's
  `voicePresence` does. `OnVoicePresence` fires on joins, leaves, timeouts
  and mute/deaf changes.
- **Mesh:** the same messages as `call/engine.ts`: `join`, then
  `here`/`full`, then `offer`/`answer`/`ice`. Existing occupants make the
  offer. Beats go out every 15 s, and the bot does ICE restarts as the
  offerer.
- **Send-only audio:** the audio is negotiated as `sendonly`, so phones
  don't upload to the bot. Its beats always say `deaf: true`, which is
  accurate, and `muted` is true whenever nothing is playing.
- **Audio settings:** copy `call/sdp.ts`: mono, CBR, 32 kbps, in-band FEC,
  and no `ssrc-audio-level` header extension.
- **One track:** a single local track goes to every peer.
  - `audio.OggFile` sends the Opus pages as-is, with no codec library.
  - `audio.PCM(io.Reader, rate)` needs `-tags opus`, which uses libopus via
    cgo, so the default build stays pure Go.
- **Limits:**
  - The bot takes one of the 8 slots.
  - ICE servers come only from `Config.ICEServers`.
  - Uploading costs up to 7 × 32 kbps.
- **To check against a real phone:** `call/quality.ts` must not show a peer
  that never receives audio as weak or stalled. If it does, fix it in the app.

## 6. Stock bot CLI (`cmd/superchat-bot`)

```
superchat-bot init [--phrase]   # new account or restore; random name; prompt for the admin password;
                                # prints the 24-word recovery phrase once
superchat-bot run               # the daemon
superchat-bot join <link>       # first way into a chat (talks to the daemon over a unix socket in DataDir)
superchat-bot passwd            # change the admin password
```

Custom bots get the same CLI by calling `cli.Main(b)` instead of `b.Run`.
The bot's phrase also works in the app, which helps with debugging.

## Phases

1. **Groundwork.**
   - ~~Move `server/proto` to `shared/proto` and add `go.work`.~~ Done.
   - Write `shared/crypto`, with the TS test-vector exporter and Go interop
     tests.
   - Write `shared/wire`, and move the server's WebSocket messages onto it.
   - Create `bot/go.mod`.
   - *Done when* every vector round-trips and `run-tests` passes. It now runs
     the `shared/` tests too.
2. **A bot that answers.**
   - Write `store`, the WebSocket and catch-up, ingest, and `Join(link)`.
   - Add `init`/`run`/`join` and a hard-coded reply when the bot is
     mentioned.
   - *Done when* a phone invites the bot, mentions it, and gets a reply, and
     a restart neither replays nor drops messages.
3. **Framework and core commands.**
   - Write `Command`/`Ctx`/hooks, `login` and admins, `name`/`picture`
     across rooms, `join`/`leave`, rotation and re-publishing the profile,
     `removeRoom`, and rate limits.
   - *Done when* a kick from the phone cleans up the room within one
     WebSocket event, and two bots in one chat each answer only their own
     mentions.
4. **Voice.**
   - Build in this order: presence first, then join/leave with silence, then
     `OggFile` playback, then PCM under `-tags opus`.
   - *Done when* phones on Android and web hear a clip, the bot's tile shows
     it as speaking or muted, and a kick ends its call.
5. **Polish.** An example bot in `bot/examples/`, Go docs, a `bot/v0.1.0`
   tag, and optionally `lib`/NixOS helpers in the flake for our own boxes.

## Risks
- **Crypto drift between Go and TS** is the main risk. The vector exporter is
  what guards against it, so any later change to the TS crypto has to
  re-export the vectors.
- **`login` puts the password into the room's history.** It's encrypted, but
  any member can read it, and it stays until retention removes it or someone
  deletes it. This is accepted and documented, and `help` warns about it.
- **The app may not handle a send-only peer well.** See section 5.
