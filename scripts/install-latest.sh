#!/usr/bin/env bash
# One-time switch of /Applications/CPA Desk.app to the latest GitHub release. Needed only
# for builds older than 1.0.0, which have no in-app updater; later versions update themselves.
#
# Downloads the release, checks its SHA-256 and bundle id, quits CPA Desk (the proxy on
# 8317 is down for a few seconds), keeps the old app as ~/Applications/CPA Desk (previous).app,
# installs the new one and opens it. Settings, accounts and data are not touched.
set -euo pipefail

repo="rafay99-epic/EasyCLIProxyAPI"
app="/Applications/CPA Desk.app"
backup="$HOME/Applications/CPA Desk (previous).app"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

release="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest")"
tag="$(jq -r .tag_name <<<"$release")"
asset_url="$(jq -r '.assets[] | select(.name | endswith("_aarch64.app.tar.gz")) | .browser_download_url' <<<"$release")"
sums_url="$(jq -r '.assets[] | select(.name == "SHA256SUMS.txt") | .browser_download_url' <<<"$release")"
[[ -n "$asset_url" && -n "$sums_url" ]] || { echo "Release $tag has no app archive" >&2; exit 1; }

echo "Downloading CPA Desk $tag"
curl -fsSL -o "$work/$(basename "$asset_url")" "$asset_url"
curl -fsSL -o "$work/SHA256SUMS.txt" "$sums_url"
(cd "$work" && shasum -a 256 -c SHA256SUMS.txt)

mkdir -p "$work/app"
tar -xzf "$work/$(basename "$asset_url")" -C "$work/app"
new_app="$work/app/CPA Desk.app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$new_app/Contents/Info.plist")"
[[ "$bundle_id" == com.rafay.cpadesk ]] || { echo "Unexpected bundle id $bundle_id" >&2; exit 1; }

echo "Quitting CPA Desk"
osascript -e 'tell application id "com.rafay.cpadesk" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do pgrep -f "$app/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
if pgrep -f "$app/Contents/MacOS/" >/dev/null; then
  echo "CPA Desk is still running; quit it from the menu bar and run this again" >&2
  exit 1
fi

if [[ -d "$app" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$backup"
  mv "$app" "$backup"
  echo "Previous version kept at $backup"
fi
ditto "$new_app" "$app"
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
open "$app"
echo "CPA Desk $tag installed. From now on it updates itself."
