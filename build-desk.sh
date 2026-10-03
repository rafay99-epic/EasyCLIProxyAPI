#!/usr/bin/env bash
# Builds CPA Desk with the patched core bundled.
#
#   ./build-desk.sh [dev|prod] [core archive]
#
# dev (default): "CPA Desk Dev" (com.rafay.cpadesk.dev, port 8337, sandbox locked on,
#   no production import, no launch at login), installed to /Applications/CPA Desk Dev.app.
# prod: "CPA Desk" (com.rafay.cpadesk). Built only, never installed. Prod is updated by
#   GitHub releases (.github/workflows/release.yml) through the in-app updater.
#
# Without a core archive the core is built from $CPA_CORE_DIR (default ../cpa-core) at the
# version in core.ref.
#
# Environment:
#   DESK_VERSION=1.2.3          app version instead of tauri.conf.json's
#   DESK_UPDATER_ARTIFACTS=1    also write the signed .app.tar.gz for the updater
#                               (needs TAURI_SIGNING_PRIVATE_KEY[_PASSWORD])
#   DESK_NO_INSTALL=1           dev: build without installing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

channel=dev
if [[ "${1:-}" == dev || "${1:-}" == prod ]]; then
  channel="$1"
  shift
fi

core_value() { sed -nE "s/^$1=(.*)$/\1/p" core.ref; }
core_archive="${1:-}"
if [[ -z "$core_archive" ]]; then
  core_dir="${CPA_CORE_DIR:-$ROOT_DIR/../cpa-core}"
  if [[ "$(git -C "$core_dir" rev-parse HEAD)" != "$(core_value ref)" ]]; then
    echo "warning: $core_dir is not at core.ref $(core_value ref)" >&2
  fi
  core_archive="$(scripts/build-core.sh "$core_dir" "$(core_value version)" "$ROOT_DIR/.build/core")"
fi
archive_name="$(basename "$core_archive")"
core_version="${archive_name#CLIProxyAPI_}"
core_version="${core_version%_darwin_aarch64.tar.gz}"

rm -rf cpa-core
mkdir -p cpa-core
cp "$core_archive" "cpa-core/$archive_name"
printf '%s\n' "$core_version" > core-version.txt

configs=(--config src-tauri/tauri.desk.conf.json)
if [[ "$channel" == dev ]]; then
  configs+=(--config src-tauri/tauri.dev.conf.json)
  app_name="CPA Desk Dev"
  bundle_id="com.rafay.cpadesk.dev"
else
  app_name="CPA Desk"
  bundle_id="com.rafay.cpadesk"
fi
if [[ "${DESK_UPDATER_ARTIFACTS:-}" == 1 ]]; then
  configs+=(--config src-tauri/tauri.release.conf.json)
fi
if [[ -n "${DESK_VERSION:-}" ]]; then
  configs+=(--config "{\"version\":\"$DESK_VERSION\"}")
fi

bun install
CPA_DESK_CHANNEL="$channel" RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}" bun tauri build --bundles app "${configs[@]}"

built="$ROOT_DIR/src-tauri/target/release/bundle/macos/$app_name.app"
actual_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built/Contents/Info.plist")"
if [[ "$actual_id" != "$bundle_id" ]]; then
  echo "Built bundle id is $actual_id, expected $bundle_id. Not installing." >&2
  exit 1
fi

if [[ "$channel" == prod || "${DESK_NO_INSTALL:-}" == 1 ]]; then
  echo "Built $app_name (not installed): $built (core $core_version)"
  exit 0
fi

# Dev only: replace /Applications/CPA Desk Dev.app. Quits the running Dev app by bundle id;
# Prod (com.rafay.cpadesk) is never addressed.
target="/Applications/CPA Desk Dev.app"
osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f "$target/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
rm -rf "$target"
ditto "$built" "$target"
echo "Installed Dev: $target (core $core_version)"
