#!/usr/bin/env bash
# Publishes a signed Dev build to the rolling "dev-latest" pre-release, which only
# CPA Desk Dev checks (when you press Check now). Used to test updates before Prod.
#   scripts/publish-dev.sh <version, e.g. 1.0.1-dev.1>
# Needs the updater key: ~/.tauri/cpa-desk-updater.key and .password.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
version="${1:?version}"
repo="rafay99-epic/EasyCLIProxyAPI"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/cpa-desk-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.tauri/cpa-desk-updater.password")"

DESK_VERSION="$version" DESK_UPDATER_ARTIFACTS=1 DESK_NO_INSTALL=1 ./build-desk.sh dev

bundle="src-tauri/target/release/bundle/macos"
out=".build/dev-release"
rm -rf "$out" && mkdir -p "$out"
asset="CPA-Desk-Dev_${version}_aarch64.app.tar.gz"
cp "$bundle/CPA Desk Dev.app.tar.gz" "$out/$asset"
cp "$bundle/CPA Desk Dev.app.tar.gz.sig" "$out/$asset.sig"
jq -n --arg version "$version" --arg notes "Dev build $version." \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --rawfile signature "$out/$asset.sig" \
  --arg url "https://github.com/$repo/releases/download/dev-latest/$asset" \
  '{version: $version, notes: $notes, pub_date: $date,
    platforms: {"darwin-aarch64": {signature: $signature, url: $url}}}' > "$out/latest.json"

gh release delete dev-latest --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
gh release create dev-latest --repo "$repo" --prerelease --title "CPA Desk Dev (rolling)" \
  --notes "Rolling Dev build for testing the updater. CPA Desk (Prod) never reads this." \
  "$out/$asset" "$out/$asset.sig" "$out/latest.json"
echo "Published Dev $version to dev-latest"
