# Super Chat app

Bare React Native 0.75 (Android) plus a Vite/react-native-web build from the
same code, built on super-badger's app: the same drawer, header, themes,
notifications, splash and sideload updater.

```sh
npm ci
npm run web            # browser client on :5173
npm run android        # on a device/emulator (system Android SDK)
npm test               # unit tests (crypto, logo, splash, icon)
E2E=1 npx jest __tests__/e2e.test.ts --forceExit   # builds and runs the real server
```

## Layout

- `src/crypto/` — the client half of `docs/protocol.md`: identity and the
  recovery phrase, sealing, the room log and its rules, messages, invites. The
  Go server has the same rules in `server/proto`; `__tests__/crypto.test.ts`
  writes a log that `server/proto/interop_test.go` replays.
- `src/store.ts` — every room's verified log, keys and decrypted messages, kept
  live over one WebSocket per server. All actions (send, invite, kick…) are here.
- `src/api.ts` — signed requests. There are no logins or tokens.
- `src/keystore.ts` / `keystore.web.ts` — where the key lives: the Android
  Keystore behind biometrics/PIN, or the browser behind a passphrase.
- `src/screens/` — onboarding, lock, room, room settings, new room/join, settings.

## Security notes

- `MainActivity.kt` sets `FLAG_SECURE`: no screenshots, screen recording, or
  recents thumbnail. React Native's `<Modal>` opens its own window without
  that flag, so anything showing message content uses `components/Overlay.tsx`
  instead.
- Plaintext never touches disk: messages are decrypted into memory, picked
  files are read and their cache copies deleted, images render from in-memory
  data URIs.
- Background notifications use the app's own WebSocket in a foreground
  service (no FCM). Message text is shown only if "Show message text" is on.

# Launch splash and icons

The splash is super-badger's animation with a pixel-art chat bubble in place of
the badger: the bubble settles in, the "Super Chat" letters rise one by one,
then a shine sweeps across and lights the typing dots. Tap to skip; it honors
"reduce motion", and turns itself off if it fails to finish twice in a row.
`/splash-preview.html?theme=ember` on the web build shows it on its own.

The launcher icon is the bubble, one per theme, switched as the app goes to the
background (Settings → "Match app icon to theme").

**The art is generated, not drawn here.** Edit `art/mark.txt` (the bubble) or
`art/word.txt` (the wordmark; "Super" and "a" come from super-badger's), then:

    cd tools && go run ./appart              # -> src/logo/logoData.ts, iconPalette.json, launcher icons
    cd tools && go run ./appart -preview /tmp/out   # also PNG previews per theme

Theme colors are read from `src/theme.tsx`.
