# CPA Desk (fork of EasyCLIProxyAPI)

Personal fork with a black, hairline UI, an Overview page for Claude limits, reset-first
account routing, a live menu bar gauge with a popover, and a patched proxy core that keeps
sessions on their account when failures aren't the account's fault (each move rewrites the
session's prompt cache).

Base: upstream `router-for-me/EasyCLIProxyAPI` @ `90364e9` (v0.3.12).
Core: `~/Code/cpa-core`, upstream `router-for-me/CLIProxyAPI` @ `v8.0.6` + `patches-rafay/`.

## Two builds: Prod and Dev

Prod is in daily use. All development is built and tested as Dev, which can't reach Prod.
The channel is compiled in (`CPA_DESK_CHANNEL`, read by `IS_DEV_BUILD` in `main.rs`), so a
wrong config can't point a Dev binary at Prod.

| | Prod | Dev |
|---|---|---|
| App | `/Applications/CPA Desk.app` | `/Applications/CPA Desk Dev.app` |
| Bundle id / data dir | `com.rafay.cpadesk` | `com.rafay.cpadesk.dev` (`tauri.dev.conf.json`) |
| Port | 8317 (imported from EasyCLIProxyAPI) | 8337; 8317 is rewritten on load |
| Agent configs | live (`~/.claude`, `~/.codex`) after the import | sandbox only, the switch is refused |
| Import from EasyCLIProxyAPI | once, then locked | disabled |
| Launch at login | toggle in the menu bar popover | disabled |
| Look | gauge icon | gauge icon with DEV label, "DEV" in the menu bar |
| Updates | GitHub Releases, checked automatically | `dev-latest` pre-release, on Check now |

Setup refuses to start if the bundle identifier doesn't match the compiled channel.
Never copy Prod's credential files into Dev: a token refresh there rotates Prod's login.

The upstream app (`com.cpa.gui`) is retired; its data was imported into Prod and it must
not be opened again.

## What changed

- `src/App.tsx`, `src/pages/desk/*`: the shell and the Overview, Accounts, Clients and
  Settings pages; legacy pages are embedded and restyled by `src/styles/desk.css`.
- `src/services/limits.ts`: pure parsing and planning (tests: `bun test tests/limits.test.ts`).
- `src/services/routingController.ts`: app-wide loop that writes account `priority`
  in reset-first or manual order. Pinned sessions ignore priority, so reorders never move a warm cache.
- `src-tauri/src/menubar.rs`, `src/TrayPanel.tsx`: template gauge glyph (serving account's
  week) and the popover window. The main window publishes snapshots and runs actions
  (`src/components/desk/MenubarBridge.tsx`); the popover only renders.
- `src-tauri/src/migration.rs`: one-time import from EasyCLIProxyAPI.
- `src-tauri/src/session_events.rs`: reads session moves and warm sessions from the core log.
- Defaults: fill-first, session affinity on with a 70m TTL, `save-cooldown-status: true`.

## Porting upstream changes

This fork and its core patches stay on `rafay/main`; nothing is sent upstream. Port security
fixes from upstream always; port anything else only if you want it.

Upstream is the `upstream` remote. Review, then cherry-pick what you want:

```sh
git fetch upstream
git log --oneline 90364e9..upstream/main          # what's new
git show <sha>                                     # read it
git cherry-pick <sha>                              # take it
```

Conflicts are most likely in `src/App.tsx`, `src-tauri/src/main.rs`,
`src-tauri/src/core_config/settings.rs` and the agents module (sandbox redirect).
Security fixes in the core go through `~/Code/cpa-core` the same way, see
`patches-rafay/README.md` there.

## Releases and updates

Prod updates itself from this fork's GitHub Releases (`tauri-plugin-updater`).

1. Push to `main`. `.github/workflows/release.yml` picks the next version from the commits
   since the last `v1+` tag (`feat` minor, `type!:` major, anything else patch), builds the
   pinned core (`core.ref`) and Prod, signs the update and publishes `vX.Y.Z` with notes
   generated from the commit messages (`scripts/release-notes.sh`). Run it by hand from the
   Actions tab to choose the bump.
2. CPA Desk checks `releases/latest/download/latest.json` a minute after launch and every
   6 hours, downloads and verifies the update in the background, and shows "Update ready".
3. It installs when you click Restart (popover or Settings, Versions). Settings and data stay.

Write commit messages as release notes: the subject becomes a bullet and `- ` lines in the
body become sub-points.

Signing key: `~/.tauri/cpa-desk-updater.key` (+ `.password`), also stored as the repository
secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key
is in `tauri.conf.json`. Losing the private key means installed apps can't verify new
updates, so keep a backup.

Core updates ride along: bump `version` in `core.ref` together with `ref`, and the app
installs the bundled core on first launch after the update. Upstream core downloads are
disabled in the app.

Dev tests updates without touching Prod: `scripts/publish-dev.sh 1.2.3-dev.1` publishes a
signed Dev build to the `dev-latest` pre-release, and CPA Desk Dev checks it on
Check now. Prod never reads pre-releases.

Versions older than 1.0.0 have no updater. Move one onto the release track once with
`scripts/install-latest.sh` (quits CPA Desk for a few seconds, keeps the old app in
`~/Applications/CPA Desk (previous).app`).

## Build

```sh
./build-desk.sh dev            # build the core from ../cpa-core, build and install Dev
./build-desk.sh prod           # build Prod locally (never installed)
```

`dev` (the default) builds and installs `/Applications/CPA Desk Dev.app`, quitting only the
Dev app. Pass a core archive as the last argument to skip building the core.

Rust tests run per channel: `cargo test` (Prod) and `CPA_DESK_CHANNEL=dev cargo test` (Dev).
