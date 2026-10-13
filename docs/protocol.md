# Super Chat protocol (v1)

Everything here is implemented twice: in Go (`server/proto`, which the server
uses to validate) and in TypeScript (`app/src/crypto`, which every client uses
to verify the server). The two must agree byte for byte.

## Encodings

- `b64` is unpadded base64url (RFC 4648 §5).
- A **member ID** is a 32-byte Ed25519 public key in lowercase, unpadded
  RFC 4648 base32 (52 chars). Members are room-scoped pseudonyms (below); the
  ID *is* the key, so nobody can swap a key behind an ID.
- Room, message, invite and blob IDs are 16 random bytes in `b64` (22 chars).
- Timestamps are unix milliseconds.
- `‖` means byte concatenation; string literals are UTF-8.

## Identity: no accounts, one pseudonym per room

```
entropy   = 32 random bytes; the recovery phrase is its BIP-39 (English) encoding, 24 words
```

There is no account key, and nothing about the account is ever sent to a
server. In each room, a person is a different member whose keys come from the
entropy and the room ID:

```
edSeed(room) = HKDF-SHA256(ikm=entropy, salt="superchat/v1", info="room-ed25519|" ‖ room, 32)
xPriv(room)  = HKDF-SHA256(ikm=entropy, salt="superchat/v1", info="room-x25519|" ‖ room, 32)
```

The same phrase gives the same member in a room on every device. Members in
different rooms can't be linked without the phrase. A member's X25519 key is
published in the event that adds them (`create` or `join`), so the room log
alone says how to seal to every member.

The **key file** (`superchat-key.json`) is
`{"v":1,"kdf":"scrypt","n":32768,"r":8,"p":1,"salt":b64,"ct":b64}`,
where `ct = aead(scrypt(passphrase, salt), entropy, "superchat-key")`.

## Signed requests (no logins)

Room requests are signed by the member key for that room:

```
X-SC-Member: <member ID>
X-SC-Ts:     <ms>
X-SC-Nonce:  <16 random bytes, b64>
X-SC-Sig:    b64(Ed25519("SC1\n" ‖ METHOD ‖ "\n" ‖ path?query ‖ "\n" ‖ ts ‖ "\n" ‖ nonce ‖ "\n" ‖ hex(sha256(body))))
```

The server rejects a `ts` more than 60 s from its own clock, and a nonce it
has already seen in the last 5 minutes. It looks nothing up about the signer:
each handler only checks that this member key is in the room named in the URL.
`GET /v1/invites/:id` and `GET /v1/vault/:id` are unsigned.

**WebSocket** (`/v1/ws`): the server sends `{"type":"challenge","nonce"}`.
The client then subscribes to rooms with
`{"type":"sub","subs":[{room, member, sig}]}`, where
`sig = Ed25519(member, "SC1-WS\n" ‖ nonce ‖ "\n" ‖ room)`. It can send more
`sub` messages later, and the server answers each with
`{"type":"subscribed","rooms":[…],"rejected":[…]}`. Subscriptions live only
in memory.

## Finding your rooms again (the vault)

The server can't list "your rooms", because it doesn't know you. Each device
keeps its room list locally, and also keeps an encrypted copy on each server
covering that server's rooms:

```
vaultSeed = HKDF(entropy, "vault-sign|" ‖ server)    (Ed25519 seed; signs writes)
vaultKey  = HKDF(entropy, "vault-enc|" ‖ server)
vaultId   = b64(sha256("sc-vault" ‖ vaultPub)[0:16])
blob      = aead(vaultKey, u32 len ‖ json ‖ zero padding to a 4096-byte multiple, "sc-vault|" ‖ vaultId)
json      = {"v":1,"rooms":[room IDs]}
```

`PUT /v1/vault/:id {blob}` is signed by the vault key, and the server only
accepts it when `id` is that key's `vaultId`. `GET /v1/vault/:id` returns
the blob. Nothing about a vault is timestamped. Clients delay each write by a
random 30 s to 5 min, so a write can't be lined up with the join or create
that caused it. A device restored from the phrase reads the vault on each
server it knows about (the default one, plus any you add).

## Sealing (one envelope per recipient)

```
seal(recipientXPub, msg, ad):
  eph    = random X25519 keypair
  key    = HKDF-SHA256(ikm=X25519(eph.priv, recipientXPub), salt=eph.pub ‖ recipientXPub, info="sc-seal-v1", 32)
  nonce  = 24 random bytes
  return eph.pub ‖ nonce ‖ XChaCha20-Poly1305(key, nonce, msg, ad)
```

Every symmetric encryption `aead(key, plaintext, ad)` below means
`nonce(24) ‖ XChaCha20-Poly1305(key, nonce, plaintext, ad)`.

## Room log

A room is a hash chain of signed **events**. Each event is sent as
`{"body": b64(bodyBytes), "sig": b64}`, where `bodyBytes` is JSON:

```json
{"v":1,"room":"…","seq":0,"prev":"","author":"<memberId>","ts":1739999999999,
 "kind":"create","pub":{…},"epoch":0,"enc":""}
```

- `sig = Ed25519(author, "sc-evt" ‖ bodyBytes)`
- `hash = b64(sha256(bodyBytes ‖ sig))`. The next event's `prev` is this hash.
  `seq` starts at 0 and goes up by one per event.
- `enc` is optional (empty if absent) and is
  `b64(aead(K_epoch, json, "sc-evt|" ‖ room ‖ "|" ‖ epoch ‖ "|" ‖ author ‖ "|" ‖ kind))`.
  It holds whatever the server shouldn't see: names, colors, display names.
- `ts` must be within 5 minutes of the server's clock when the event is appended.

Signing the exact bytes as sent means there's no canonicalisation. The server
stores and serves the bytes unchanged.

### State, derived by replaying the log

- `members`: member → `admin | member`
- `keys`: member → X25519 key (b64), from their `create`/`join`
- `epoch`: the latest epoch number. `pendingRotation` is set by a
  join/kick/leave and cleared by an epoch event.
- `invites`: id → `{pub, expiresAt, maxUses, uses, revoked}`
- `retentionDays`

### Event kinds and who may author them

| kind     | author                       | pub                                                   | effect |
|----------|------------------------------|-------------------------------------------------------|--------|
| `create` | anyone (seq 0 only)          | `{retentionDays, x25519}`                             | author becomes admin |
| `epoch`  | a member who is admin, or anyone while `pendingRotation` | `{epoch: n+1, recipients:[ids], commit: b64}` | new key. `recipients` must equal the current members exactly (sorted) |
| `meta`   | admin                        | `{}` (name/color in `enc`)                            | room name and color |
| `profile`| member, about themselves     | `{}` (displayName, avatar in `enc`)                   | display name, picture |
| `settings`| admin                       | `{retentionDays}` (0 = keep forever, max 3650)        | |
| `invite` | admin                        | `{id, key: b64 ed25519 pub, expiresAt, maxUses}` (0 = unlimited) | creates the invite |
| `revoke` | admin                        | `{id}`                                                | `invites[id].revoked = true` |
| `join`   | a non-member                 | `{invite: id, proof: b64, x25519}`                    | becomes member, `pendingRotation` |
| `promote`/`demote` | admin              | `{target}` (must be a member)                         | sets the role |
| `kick`   | admin                        | `{target}` (must be a member other than the author)   | removes the target, `pendingRotation` |
| `leave`  | member                       | `{}`                                                  | removes the author, `pendingRotation` |
| `delete` | the message's sender, or an admin | `{msg: id, sender: id}`                          | the server hard-deletes it. Clients check that `sender` is the message's signed inner sender, or that the author is an admin |
| `wipe`   | admin                        | `{}`                                                  | the server hard-deletes every message in the room so far, with its attachments (not avatars). The event stays, so clients show who wiped the chat and when; a client that sees a wipe it hasn't handled drops what it holds and reloads |

A **join** is valid only when:
- the invite exists, isn't revoked, and
  `ts ≤ expiresAt` (if `expiresAt` isn't 0), and
- `uses < maxUses` (if `maxUses` isn't 0), and
- `proof = Ed25519(inviteKey, "sc-join|" ‖ room ‖ "|" ‖ inviteId ‖ "|" ‖ author)`

The invite key pair comes from the link secret:
`inviteSeed = HKDF-SHA256(secret, salt="superchat/v1", info="invite-sign", 32)`.
The secret sits after `#` in the URL and never reaches the server, so neither
the server nor anyone without the link can produce a proof. Every client
checks the proof itself.

**An epoch key** is 32 random bytes, with
`commit = b64(sha256("sc-commit|" ‖ room ‖ "|" ‖ n ‖ "|" ‖ key))`.
It's uploaded with its event as `envelopes: {memberId: b64(seal(xPub, key, "sc-env|" ‖ room ‖ "|" ‖ n ‖ "|" ‖ memberId))}`,
one per recipient, sealed to the X25519 key that member published in the log. A recipient accepts the key only if it matches `commit`.
Joiners only receive envelopes for epochs created after they joined, which is
what keeps the history before they joined unreadable to them.

A rotator that already knows the room's state puts a snapshot
`{name, color, profiles:{id:displayName}}` in the epoch event's `enc`. When a
client sees a new epoch it didn't create, it re-publishes its own `profile`
under that epoch.

### Appending events

`POST /v1/rooms/:id/events {"events":[…], "envelopes": {…}?}` takes a batch
that is validated and applied atomically, in order. A batch may contain at
most one epoch event, and envelopes go with it. If the first event's
`seq`/`prev` aren't the current head you get `409 {"error":"conflict","head":{seq,hash}}`;
refetch and retry.

`POST /v1/rooms {"events":[create, epoch(1), meta, profile], "envelopes":{…}}`
creates a room. The room ID is the one in the `create` body.

`POST /v1/invites/:id/join {"events":[join, epoch, profile], "envelopes":{…}}`
lets a non-member join. Before joining, the client calls
`GET /v1/invites/:id` → `{room, preview, events}` (unsigned). `preview`
is `aead(HKDF(secret,"superchat/v1","invite-preview",32), {name,color,inviter}, "sc-preview")`.
The joiner signs its join event and immediately rotates the epoch so that
nobody can be waiting on an admin.

## Messages

`POST /v1/rooms/:id/messages {"id","epoch","kind","ct","blobs":[ids]}`, where
`kind` is one of `msg` (notifies), `reaction` or `receipt` (the server keeps
only the latest receipt per sender). `epoch` must be the room's current epoch.

```
inner  = JSON {"v":1,"t":"text"|"file"|"reaction"|"receipt", ...content, "ts"}
sig    = Ed25519(sender, "sc-msg|" ‖ room ‖ "|" ‖ id ‖ "|" ‖ inner)
ct     = b64(aead(K_epoch, JSON{"c": b64(inner), "s": b64(sig)}, "sc-msg|" ‖ room ‖ "|" ‖ epoch ‖ "|" ‖ id ‖ "|" ‖ sender))
```

The content is one of:
- text: `{body, replyTo?}`
- file: `{files:[{blob, key, name, mime, size, w?, h?}], body?, replyTo?}`
- reaction: `{target, emoji, remove?}`
- receipt: `{upTo}`

**Blobs**: `PUT /v1/rooms/:id/blobs` (raw body, at most 25 MB) → `{id}`, and
`GET /v1/rooms/:id/blobs/:blob`. The bytes are `aead(fileKey, file, "sc-blob")`.
A blob that no message references within an hour is swept.

**Profile pictures**: a member uploads the sealed picture as a blob, then
`PUT /v1/rooms/:id/avatar {"blob": id}` marks it as theirs (`""` clears it). An
avatar blob is readable by every member, is kept by the sweeper while its
uploader is in the room, and is replaced (deleted) by the next one. The key
travels in the member's `profile` event: `enc.avatar = {blob, key, at}` (`null`
= removed; absent = unchanged), so the server knows which blob is someone's
picture but never sees it. A new picture is always a new blob, so clients
cache by blob id and refetch only when the profile points somewhere new. `at`
is when it was set; a device only replaces a picture newer than its own.

Members only ever see messages and envelopes from epochs at or after their
first one.

## Retention and deletes

`retentionDays` comes from the log. Every hour the server deletes messages
older than that, along with their blobs. Clients drop them from memory by the
same rule. A `delete` event hard-deletes the message row and its blobs, and
every client is told over WebSocket. A `wipe` event does the same for every
message in the room up to it.

## WebSocket events (server → client)

- `{"type":"event","room","event":{body,sig,hash}}`
- `{"type":"message","room","message":{…}}`
- `{"type":"deleted","room","ids":[…]}`
- `{"type":"typing","room","member"}`
- `{"type":"removed","room"}` (you are no longer a member)

The only client → server message is `{"type":"typing","room"}`, which goes to
the room's other members and is never stored.
