# release/

Local signing material and the guided release tool for the Android app.
Mirrors `../horus-33/release/`.

Tracked in git: `release.sh`, `gen-keystore.sh`, `README.md`, `.gitignore`.
**Never** committed: `release.keystore`, `keystore.env`, or any built `.apk`.

## First-time setup

```
./release/gen-keystore.sh
```

Generates `release.keystore` (a real Android signing key, valid ~27 years)
and `keystore.env` (its passwords). Refuses to run again once these exist —
regenerating would produce a *different* key, and Android won't install an
update signed by a different key over an app installed from the old one, so
losing/replacing this keystore means every existing install of the app can
never again be updated in place (only uninstalled and reinstalled fresh).
**Back up `release.keystore` and `keystore.env` somewhere durable outside
this checkout.**

## Cutting a release

```
./release/release.sh
```

(or `npm run release` from `app/`, which just calls this)

The script: checks the toolchain, sources `keystore.env`, lists existing
`app-v*` tags, prompts for the new tag (e.g. `app-v0.3.2`) and a
`versionCode`, runs the real `./gradlew assembleSideloadRelease` with full output,
then — after a single confirmation — creates and pushes the tag and publishes
a GitHub Release with the signed APK attached (named `superchat-<tag>.apk`,
matching `app/src/appUpdater.ts`'s `APK_NAME` regex so the in-app updater
actually finds it).

Assumes `git`, `java`, the Android SDK/build-tools, and `gh` (authenticated)
are installed — all present in this repo's `nix develop` shell.

The signed APK is also left at `release/superchat-<tag>.apk` (gitignored).

## Google Play build

The app has two flavors (`app/android/app/build.gradle`): `sideload`, which
`release.sh` builds and the in-app updater installs, and `play`, for Google
Play (FCM notifications; no in-app updater or always-on background
connection, which Play doesn't allow). Build the Play app bundle with:

```sh
release/release-play.sh
```

`release.sh` does the same for the sideload APK: the last versionCode built is
kept in `sideload-version.env` (gitignored), the next one suggested above it,
and anything lower refused.

`release-play.sh` suggests the next version from the last Play build (`play-version.env`,
with every build logged in `play-releases.log`; both gitignored), builds and
signs `superchat-play-<version>.aab` here, and only records the version once
the build worked. Play's versionCodes start at 100, above the sideload
builds', so the two never collide. Upload the `.aab` in the Play Console.
