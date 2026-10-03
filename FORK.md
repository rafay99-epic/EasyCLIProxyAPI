# CPA Desk (fork of EasyCLIProxyAPI)

Personal fork with a black, hairline UI, an Overview page for Claude limits, reset-first
account routing, and a patched proxy core that keeps sessions on their account when
failures aren't the account's fault (each move rewrites the session's prompt cache).

Base: upstream `router-for-me/EasyCLIProxyAPI` @ `90364e9` (v0.3.12).
Core: `~/Code/cpa-core`, upstream `router-for-me/CLIProxyAPI` @ `v8.0.6` + `patches-rafay/`.

## Runs next to the upstream app without touching it

| | Upstream app | CPA Desk |
|---|---|---|
| Bundle id / data dir | `com.cpa.gui` | `com.rafay.cpadesk` (`APP_IDENTIFIER`, guarded by a test) |
| Default port | 8317 | 8327 |
| Instance lock | `EasyCLIProxyAPI-instance` | `CPADesk-instance` |
| Self-update | on | off (`APP_SELF_UPDATE_DISABLED`) |
| Agent configuration | writes `~/.claude`, `~/.codex`, ... | writes `<data dir>/agent-sandbox-home` until switched to live on the Agent Configuration page |

OAuth accounts are not shared. Sign in again inside CPA Desk; each sign-in gets its own
token, so the two apps never fight over refresh tokens.

## What changed

- `src/pages/OverviewPage.*`: focus account, accounts ledger (5h, week, Fable week, left at
  reset), next 7 days of resets, warm sessions, session moves, routing controls.
- `src/services/limits.ts`: pure parsing and planning (tests: `bun test tests/limits.test.ts`).
- `src/services/routingController.ts`: app-wide loop that writes account `priority`
  in reset-first order. Pinned sessions ignore priority, so reorders never move a warm cache.
- `src-tauri/src/session_events.rs`: reads session moves and warm sessions from the core log.
- `src/styles/desk.css`: restyle layer (dark only, no boxes in boxes).
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

## Build

```sh
./build-desk.sh /tmp/cpa-core-build/CLIProxyAPI_8.0.6-rafay.1_darwin_aarch64.tar.gz
```

Output: `src-tauri/target/release/bundle/macos/CPA Desk.app`. Nothing is installed into
`/Applications`.
