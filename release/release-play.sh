#!/usr/bin/env bash
#
# release-play.sh — build the Google Play app bundle (.aab).
#
# The Play flavor (app/android/app/src/play): FCM wake-ups, no in-app updater,
# no always-on background connection. Signs with the same release key as
# release.sh (release/keystore.env), and keeps track of versions so you don't
# have to:
#
#   release/play-version.env   the last Play versionName/versionCode built
#   release/play-releases.log  every Play build: date, version, commit
#
# Both are gitignored (release/.gitignore). Play needs every upload's
# versionCode higher than the last; the sideload builds (release.sh) count up
# from 1, so Play's start at 100 and never collide on the shared app ID.
#
# Afterwards, upload the .aab in the Play Console (Testing → Internal testing
# is the place to start).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
APP_ANDROID="$APP_DIR/android"
ENV_FILE="$SCRIPT_DIR/keystore.env"
KEYSTORE_FILE="$SCRIPT_DIR/release.keystore"
STATE_FILE="$SCRIPT_DIR/play-version.env"
LOG_FILE="$SCRIPT_DIR/play-releases.log"
AAB_BUILT="$APP_ANDROID/app/build/outputs/bundle/playRelease/app-play-release.aab"
FIREBASE_VALUES="$APP_ANDROID/app/src/play/res/values/google_services.xml"
FIRST_PLAY_CODE=100

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
	local prompt="$1" reply
	read -r -p "$prompt [y/N] " reply
	[[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]]
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
bold "==> Preflight"

for bin in git java; do
	command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH"
done
[[ -x "$APP_ANDROID/gradlew" ]] || die "missing $APP_ANDROID/gradlew"
[[ -f "$ENV_FILE" ]]            || die "missing $ENV_FILE — run release/gen-keystore.sh first"
[[ -f "$KEYSTORE_FILE" ]]       || die "missing $KEYSTORE_FILE — run release/gen-keystore.sh first"
[[ -f "$FIREBASE_VALUES" ]]     || die "missing $FIREBASE_VALUES (the Firebase settings for FCM)"

info "toolchain ok  ($(java -version 2>&1 | head -1))"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
	warn "the working tree has uncommitted changes; the build includes them"
fi

# ---------------------------------------------------------------------------
# 2. Load signing env
# ---------------------------------------------------------------------------
bold "==> Signing material"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export SUPERCHAT_KEYSTORE_FILE="$KEYSTORE_FILE"

for var in SUPERCHAT_KEYSTORE_PASSWORD SUPERCHAT_KEY_ALIAS SUPERCHAT_KEY_PASSWORD; do
	[[ -n "${!var:-}" ]] || die "$var is unset in $ENV_FILE"
done
info "keystore: $SUPERCHAT_KEYSTORE_FILE  alias: $SUPERCHAT_KEY_ALIAS"

# ---------------------------------------------------------------------------
# 3. Version (suggested from the last Play build)
# ---------------------------------------------------------------------------
bold "==> Version"

LAST_VERSION_NAME=""
LAST_VERSION_CODE=""
if [[ -f "$STATE_FILE" ]]; then
	# shellcheck disable=SC1090
	. "$STATE_FILE"
	info "last Play build: $LAST_VERSION_NAME ($LAST_VERSION_CODE)"
else
	info "no Play builds yet"
fi

if [[ "$LAST_VERSION_NAME" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
	suggest_name="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
else
	suggest_name="0.1.0"
fi
if [[ "$LAST_VERSION_CODE" =~ ^[0-9]+$ ]]; then
	suggest_code=$((LAST_VERSION_CODE + 1))
else
	suggest_code=$FIRST_PLAY_CODE
fi

while :; do
	read -r -p "versionName [$suggest_name]: " versionName
	versionName="${versionName:-$suggest_name}"
	[[ "$versionName" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
	warn "versionName must look like 1.2.3"
done

while :; do
	read -r -p "versionCode [$suggest_code]: " versionCode
	versionCode="${versionCode:-$suggest_code}"
	if [[ ! "$versionCode" =~ ^[0-9]+$ ]]; then
		warn "versionCode must be an integer"; continue
	fi
	if [[ "$LAST_VERSION_CODE" =~ ^[0-9]+$ ]] && (( versionCode <= LAST_VERSION_CODE )); then
		warn "versionCode must be higher than the last Play build ($LAST_VERSION_CODE), or Play rejects it"; continue
	fi
	break
done

bold "-------- Play release --------"
printf '  versionName  %s\n' "$versionName"
printf '  versionCode  %s\n' "$versionCode"
printf '  HEAD         %s\n' "$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
bold "------------------------------"
confirm "Build the Play bundle?" || { info "aborted."; exit 0; }

# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------
bold "==> Building signed Play bundle"

if [[ ! -d "$APP_DIR/node_modules" ]]; then
	info "node_modules missing — running npm ci"
	( cd "$APP_DIR" && npm ci )
fi

(
	cd "$APP_ANDROID"
	./gradlew --no-daemon bundlePlayRelease \
		-PversionName="$versionName" \
		-PversionCode="$versionCode"
)

[[ -f "$AAB_BUILT" ]] || die "expected bundle not found at $AAB_BUILT"
AAB_OUT="$SCRIPT_DIR/superchat-play-$versionName.aab"
cp "$AAB_BUILT" "$AAB_OUT"
info "copied to $AAB_OUT ($(du -h "$AAB_OUT" | cut -f1))"

if command -v jarsigner >/dev/null 2>&1; then
	jarsigner -verify "$AAB_OUT" >/dev/null 2>&1 && info "signature ok" || warn "jarsigner couldn't verify the bundle's signature"
fi

# ---------------------------------------------------------------------------
# 5. Remember the version (only once the build worked)
# ---------------------------------------------------------------------------
cat >"$STATE_FILE" <<EOF
# Written by release-play.sh: the last Google Play build. Gitignored.
LAST_VERSION_NAME=$versionName
LAST_VERSION_CODE=$versionCode
EOF
printf '%s  %s (%s)  %s\n' "$(date -Iseconds)" "$versionName" "$versionCode" \
	"$(git -C "$REPO_ROOT" rev-parse --short HEAD)" >>"$LOG_FILE"

bold "==> Done"
info "Upload $AAB_OUT in the Play Console (Testing → Internal testing to start)."
