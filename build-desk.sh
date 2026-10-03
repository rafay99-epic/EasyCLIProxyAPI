#!/usr/bin/env bash
# Builds CPA Desk (this fork) as a standalone .app with the patched core bundled.
# Usage: ./build-desk.sh /path/to/CLIProxyAPI_<version>_darwin_aarch64.tar.gz
# It never touches /Applications or the upstream app's data; the result stays in
# src-tauri/target/release/bundle/macos/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

core_archive="${1:?pass the patched core archive}"
archive_name="$(basename "$core_archive")"
core_version="${archive_name#CLIProxyAPI_}"
core_version="${core_version%_darwin_aarch64.tar.gz}"

rm -rf cpa-core
mkdir -p cpa-core
cp "$core_archive" "cpa-core/$archive_name"
printf '%s\n' "$core_version" > core-version.txt

bun install
RUSTUP_TOOLCHAIN=stable bun tauri build --bundles app --config src-tauri/tauri.desk.conf.json

echo "Built: $ROOT_DIR/src-tauri/target/release/bundle/macos/CPA Desk.app (core $core_version)"
