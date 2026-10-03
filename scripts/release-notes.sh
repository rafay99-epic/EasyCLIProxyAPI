#!/usr/bin/env bash
# Writes release notes for a version from the commits since the previous CPA Desk tag
# (or since the fork point for the first release). Commits are grouped by their
# Conventional Commit type; commit body bullet lines are kept as sub-points.
#   scripts/release-notes.sh <version> <core version> <core ref>
set -euo pipefail
version="${1:?version}"
core_version="${2:?core version}"
core_ref="${3:?core ref}"
repo="rafay99-epic/EasyCLIProxyAPI"
fork_point="90364e9"

previous="$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[1-9][0-9]*\.[0-9]+\.[0-9]+$' | grep -vx "v$version" | head -1 || true)"
range="${previous:-$fork_point}..HEAD"

declare -a features=() fixes=() improvements=() other=()
while IFS= read -r -d $'\x1e' entry; do
  subject="${entry%%$'\x1f'*}"
  body="${entry#*$'\x1f'}"
  [[ -z "$subject" ]] && continue
  type="$(sed -nE 's/^([a-z]+)(\([^)]*\))?!?: .*/\1/p' <<<"$subject")"
  text="$(sed -E 's/^[a-z]+(\([^)]*\))?!?: //' <<<"$subject")"
  text="$(tr '[:lower:]' '[:upper:]' <<<"${text:0:1}")${text:1}"
  item="- $text"
  # Body bullets become sub-points; wrapped lines are joined back onto their bullet.
  details="$(awk '
    /^[[:space:]]*- / { if (item != "") print item; sub(/^[[:space:]]*- /, ""); item = "  - " $0; next }
    /^[[:space:]]*$/ { if (item != "") print item; item = ""; next }
    { if (item != "") { gsub(/^[[:space:]]+/, ""); item = item " " $0 } }
    END { if (item != "") print item }
  ' <<<"$body")"
  [[ -n "$details" ]] && item+=$'\n'"$details"
  case "$type" in
    feat) features+=("$item") ;;
    fix) fixes+=("$item") ;;
    perf|refactor|style) improvements+=("$item") ;;
    ci|build|chore|docs|test) ;;
    *) other+=("$item") ;;
  esac
done < <(git log --no-merges --reverse --format='%s%x1f%b%x1e' "$range")

section() {
  local title="$1"; shift
  (( $# )) || return 0
  printf '### %s\n\n' "$title"
  printf '%s\n' "$@"
  printf '\n'
}

{
  section "New" "${features[@]+"${features[@]}"}"
  section "Fixes" "${fixes[@]+"${fixes[@]}"}"
  section "Improvements" "${improvements[@]+"${improvements[@]}"}"
  section "Changes" "${other[@]+"${other[@]}"}"
  if (( ${#features[@]} + ${#fixes[@]} + ${#improvements[@]} + ${#other[@]} == 0 )); then
    printf '### Changes\n\n- Maintenance release: build and release tooling only.\n\n'
  fi
  printf '### Proxy core\n\n'
  printf 'Bundled patched core **%s** ([rafay99-epic/CLIProxyAPI@%s](https://github.com/rafay99-epic/CLIProxyAPI/commit/%s)). It installs automatically when it is newer than the one you have.\n\n' "$core_version" "${core_ref:0:7}" "$core_ref"
  printf '### Install\n\n'
  printf -- '- **Already on CPA Desk 1.0.0 or later:** the update downloads by itself. Click **Restart** in the menu bar popover or in Settings, Versions.\n'
  printf -- '- **First install:** run `scripts/install-latest.sh` from the repo, or download `CPA-Desk_%s_aarch64.app.tar.gz`, quit CPA Desk, and unpack it into `/Applications`.\n\n' "$version"
  if [[ -n "$previous" ]]; then
    printf '**Full changelog:** https://github.com/%s/compare/%s...v%s\n' "$repo" "$previous" "$version"
  fi
}
