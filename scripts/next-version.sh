#!/usr/bin/env bash
# Prints the next release version from commits since the last CPA Desk tag (v1.0.0+;
# upstream's v0.x tags in this fork are ignored).
#   scripts/next-version.sh [auto|patch|minor|major]
# auto: major for "type!:" or "BREAKING CHANGE", minor when any commit starts with
# "feat", patch otherwise. Without a previous tag, the version in tauri.conf.json is used.
set -euo pipefail
bump="${1:-auto}"
last="$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[1-9][0-9]*\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [[ -z "$last" ]]; then
  sed -nE 's/^  "version": "([^"]+)",?$/\1/p' src-tauri/tauri.conf.json | head -1
  exit 0
fi
if [[ "$bump" == auto ]]; then
  log="$(git log --no-merges --format='%s%n%b' "$last..HEAD")"
  if grep -qE '^[a-z]+(\([^)]*\))?!:|BREAKING CHANGE' <<<"$log"; then bump=major
  elif grep -qE '^feat(\([^)]*\))?:' <<<"$log"; then bump=minor
  else bump=patch; fi
fi
IFS=. read -r major minor patch <<<"${last#v}"
case "$bump" in
  major) echo "$((major + 1)).0.0" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  patch) echo "$major.$minor.$((patch + 1))" ;;
  *) echo "unknown bump: $bump" >&2; exit 1 ;;
esac
