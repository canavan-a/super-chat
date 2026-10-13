# super-chat

End-to-end encrypted group chat with no accounts to sign up for. It looks and
feels like super-badger: a room drawer like super-badger's stations, the same
themes, notifications and boot screen, and a sideloaded Android APK.

- **No logins.** Your account is a key made on your phone. Back it up as a
  24-word recovery phrase or a passphrase-protected key file; either one brings
  your rooms back on another device.
- **The server can't read anything, or tell who anyone is.** It stores
  ciphertext, and in every room you're a different, unrelated key. The
  database can't show that two rooms have a person in common.
- **Invite links only.** Admins make links with an expiry and a use limit, see
  who joined through each one, and can revoke them. New members only see
  messages sent after they joined.
- **You own the history.** Each room sets how many days messages are kept, and
  the sender or an admin can delete any message for everyone.
- **No screenshots.** Android's `FLAG_SECURE` is always on.
- **Your own server, if you want.** `chat.superbadger.io` is the default; anyone
  can run the server (a single Go binary on SQLite) and add it in Settings.

## How the encryption works

Full details are in [`docs/protocol.md`](docs/protocol.md). In short:

1. **Your account** is 32 random bytes, and the recovery phrase is those bytes
   written as words. The account itself is never sent anywhere. In each room
   your phone derives a separate member key from it (Ed25519 for signing,
   X25519 for receiving keys), so to the server you're a different stranger
   in every room.
2. **Signing in** isn't a thing. Each request is signed with the member key
   for the room it's about, and the server only checks that key is in that
   room. The list of rooms you're in lives on your phone, plus an encrypted,
   padded backup on each server that only your phrase can find and open.
3. **Each room has a shared key**, and a new one is made every time someone
   joins, leaves or is removed, and at least weekly. The new key is sealed
   separately to each member's public key. Someone who leaves can't read
   anything after they're gone, and someone who joins can't read anything
   from before.
4. **Messages** are encrypted with the room key (XChaCha20-Poly1305) and signed
   by their sender, so members can't forge each other either.
5. **Membership is a signed log every member checks.** Only admins can invite,
   promote or remove people, and a join only counts if it carries a proof made
   from the invite link's secret. That secret is after the `#` in the link and
   never reaches the server. So the server can't add anyone to a room, even
   though it relays everything.

What it doesn't hide: within one room, the server sees which member keys post
and when. And while you're online, a server operator watching live traffic
could line up rooms by your IP address and connection; nothing about that is
stored, and a VPN or Tor hides it. Someone with a modified app could still
ignore deletes or screenshot blocking. Keys rotate per membership change, not per message
(Signal-style ratcheting or MLS would be a later upgrade).

## Layout

```
app/        React Native app (Android APK + web), forked from super-badger's
server/     Go + SQLite server: signed requests, room logs, WebSocket fan-out
tools/      appart: generates the logo data and launcher icons from art/
art/        the pixel art (chat bubble + "Super Chat" in super-badger's lettering)
docs/       protocol.md
release/    APK signing and the guided GitHub release (app-v* tags)
module.nix  NixOS module: services.superchat
```

## Running it

```sh
nix develop          # prints the dev commands
dev-up               # server on 127.0.0.1:8080
run-app-web          # web client on :5173; add http://127.0.0.1:8080 in Settings → Servers
run-tests            # Go tests, app tests, then a full end-to-end run
```

On NixOS:

```nix
services.superchat = {
  enable = true;
  publicOrigin = "https://chat.superbadger.io";
  web.enable = true;                  # optional browser client on :8081
};
```

It listens on loopback; put a Cloudflare tunnel (or any TLS proxy) in front.
`superchat-admin stats | delete-room <room>` is installed alongside it. It can
count and delete, but it can't read anything or tell who anyone is.

## Releases

`./release/gen-keystore.sh` once, then `./release/release.sh`. That builds the
signed APK, tags `app-vX.Y.Z` and publishes a GitHub release, which the app's
Settings → App updates installs from. Put the key's SHA-256
(`keytool -list -v -keystore release/release.keystore`) in
`services.superchat.androidCertSha256` so invite links open straight in the app.
