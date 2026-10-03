#!/usr/bin/env bash
# Builds the patched core into the archive layout CPA Desk bundles.
#   scripts/build-core.sh <core source dir> <version> <output dir>
# Prints the archive path.
set -euo pipefail
src="$(cd "${1:?core source dir}" && pwd)"
version="${2:?core version}"
out="$(mkdir -p "${3:?output dir}" && cd "$3" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
(
  cd "$src"
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath \
    -ldflags "-s -w -X main.Version=$version -X main.Commit=$commit -X main.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o "$stage/cli-proxy-api" ./cmd/server
)
for file in config.example.yaml LICENSE README.md README_CN.md; do
  [[ -f "$src/$file" ]] && cp "$src/$file" "$stage/"
done
archive="$out/CLIProxyAPI_${version}_darwin_aarch64.tar.gz"
tar -czf "$archive" -C "$stage" .
echo "$archive"
