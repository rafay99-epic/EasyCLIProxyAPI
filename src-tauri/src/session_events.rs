//! Session-affinity activity read from the core's output log.
//!
//! Anthropic prompt caches are per account, so every time the core moves a session to a
//! different account that session's cache is rewritten from scratch. The core only reports
//! these moves as log lines; this module turns the tail of that log into structured
//! "moved" events and a list of recently active (cache-warm) sessions for the Overview.

use super::*;
use std::io::{Read, Seek, SeekFrom};

/// How much of the log tail to scan. Large enough for a busy day, small enough to stay fast.
const SESSION_LOG_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// A session counts as warm while its account still holds the 1h prompt cache.
const WARM_SESSION_WINDOW_SECONDS: i64 = 60 * 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionMoveEvent {
    /// Local timestamp as printed by the core, e.g. "2026-10-02 22:57:44".
    at: String,
    session: String,
    model: String,
    /// Auth id (auth file name) the session was moved to.
    to_account: String,
    /// Auth id that failed right before the move, when the log shows one.
    from_account: Option<String>,
    /// Short failure reason from the same request, when available.
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmSession {
    session: String,
    account: String,
    model: String,
    last_seen: String,
    /// Seconds until the 1h cache window lapses, measured from the last request.
    warm_seconds_left: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActivity {
    moves: Vec<SessionMoveEvent>,
    warm_sessions: Vec<WarmSession>,
}

struct AffinityLine<'a> {
    at: &'a str,
    request_id: &'a str,
    kind: &'a str,
    session: &'a str,
    account: &'a str,
    model: &'a str,
}

/// Parses `[ts] [reqid] [info ] [selector.go:N] session-affinity: <kind> | session=.. auth=.. model=..`.
fn parse_affinity_line(line: &str) -> Option<AffinityLine<'_>> {
    let (at, rest) = line.strip_prefix('[')?.split_once("] [")?;
    let (request_id, rest) = rest.split_once(']')?;
    let (_, rest) = rest.split_once("session-affinity: ")?;
    let (kind, fields) = rest.split_once(" | ")?;
    let field = |name: &str| {
        fields
            .split(' ')
            .find_map(|part| part.strip_prefix(name)?.strip_prefix('='))
    };
    Some(AffinityLine {
        at,
        request_id,
        kind: kind.trim(),
        session: field("session")?,
        account: field("auth")?,
        model: field("model").unwrap_or(""),
    })
}

/// Parses the core's `upstream execution failed: ... auth_file=<id> ...` warning.
fn parse_failure_line(line: &str) -> Option<(&str, String, String)> {
    if !line.contains("upstream execution failed") {
        return None;
    }
    let (_, rest) = line.strip_prefix('[')?.split_once("] [")?;
    let (request_id, _) = rest.split_once(']')?;
    let account = line
        .split(' ')
        .find_map(|part| part.strip_prefix("auth_file="))?
        .trim_end_matches(',')
        .to_string();
    let reason = line
        .split_once(" err=")
        .map(|(_, err)| err)
        .or_else(|| line.split_once("upstream execution failed: ").map(|(_, rest)| rest))
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>();
    Some((request_id, account, reason))
}

fn parse_log_timestamp(at: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|naive| naive.and_local_timezone(chrono::Local).single())
        .map(|time| time.timestamp())
}

fn summarize_session_log(content: &str, now: i64, limit: usize) -> SessionActivity {
    let mut failures: HashMap<&str, (String, String)> = HashMap::new();
    let mut moves = Vec::new();
    let mut latest: HashMap<&str, AffinityLine<'_>> = HashMap::new();

    for line in content.lines() {
        if let Some((request_id, account, reason)) = parse_failure_line(line) {
            failures.insert(request_id, (account, reason));
            continue;
        }
        let Some(entry) = parse_affinity_line(line) else {
            continue;
        };
        if entry.kind.contains("auth unavailable, reselected") {
            let failure = failures.get(entry.request_id);
            moves.push(SessionMoveEvent {
                at: entry.at.to_string(),
                session: entry.session.to_string(),
                model: entry.model.to_string(),
                to_account: entry.account.to_string(),
                from_account: failure.map(|(account, _)| account.clone()),
                reason: failure.map(|(_, reason)| reason.clone()),
            });
        }
        latest.insert(entry.session, entry);
    }

    moves.reverse();
    moves.truncate(limit);

    let mut warm_sessions = latest
        .into_values()
        .filter_map(|entry| {
            let seen = parse_log_timestamp(entry.at)?;
            let left = WARM_SESSION_WINDOW_SECONDS - (now - seen);
            (left > 0).then(|| WarmSession {
                session: entry.session.to_string(),
                account: entry.account.to_string(),
                model: entry.model.to_string(),
                last_seen: entry.at.to_string(),
                warm_seconds_left: left,
            })
        })
        .collect::<Vec<_>>();
    warm_sessions.sort_by(|left, right| right.last_seen.cmp(&left.last_seen));

    SessionActivity { moves, warm_sessions }
}

#[tauri::command]
pub(crate) fn read_session_activity(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    limit: Option<usize>,
) -> Result<SessionActivity, String> {
    let config = gui_config_state.snapshot()?;
    let path = core_start_log_path(&core_install_dir()?, &config.auth_dir)?;
    let empty = || SessionActivity { moves: Vec::new(), warm_sessions: Vec::new() };
    let Ok(mut file) = fs::File::open(&path) else {
        return Ok(empty());
    };
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(SESSION_LOG_TAIL_BYTES)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    let content = String::from_utf8_lossy(&bytes);
    Ok(summarize_session_log(
        &content,
        chrono::Local::now().timestamp(),
        limit.unwrap_or(50),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "\
[2026-10-02 22:55:35] [00000e6a] [info ] [selector.go:1063] session-affinity: cache hit | session=claude:2... auth=claude-bbbb2222-weekend@x.json provider=mixed model=claude-opus-5-5
[2026-10-02 22:57:43] [00000e6b] [warn ] [conductor_execution.go:1968] upstream execution failed: provider=claude model=claude-opus-5-5 auth=provider=claude auth_file=claude-bbbb2222-weekend@x.json duration=1m46.377s err=Post \"https://api.anthropic.com/v1/messages\": write tcp: broken pipe
[2026-10-02 22:57:44] [00000e6b] [info ] [selector.go:1076] session-affinity: cache hit but auth unavailable, reselected | session=claude:2... auth=claude-aaaa1111-primary@x.json provider=mixed model=claude-opus-5-5
[2026-10-02 22:58:11] [00000e70] [info ] [selector.go:1063] session-affinity: cache hit | session=claude:2... auth=claude-aaaa1111-primary@x.json provider=mixed model=claude-opus-5-5
[2026-10-02 22:58:11] [00000e71] [info ] [gin_logger.go:103] 200 |  15.762s | 127.0.0.1 | POST \"/v1/messages?beta=true\"
";

    #[test]
    fn move_carries_previous_account_and_reason() {
        let now = parse_log_timestamp("2026-10-02 23:00:00").unwrap();
        let activity = summarize_session_log(LOG, now, 10);
        assert_eq!(activity.moves.len(), 1);
        let event = &activity.moves[0];
        assert_eq!(event.to_account, "claude-aaaa1111-primary@x.json");
        assert_eq!(event.from_account.as_deref(), Some("claude-bbbb2222-weekend@x.json"));
        assert!(event.reason.as_deref().unwrap().contains("broken pipe"));
    }

    #[test]
    fn warm_session_tracks_latest_account_and_expires_after_an_hour() {
        let now = parse_log_timestamp("2026-10-02 23:00:00").unwrap();
        let activity = summarize_session_log(LOG, now, 10);
        assert_eq!(activity.warm_sessions.len(), 1);
        assert_eq!(activity.warm_sessions[0].account, "claude-aaaa1111-primary@x.json");

        let later = parse_log_timestamp("2026-10-03 00:00:00").unwrap();
        assert!(summarize_session_log(LOG, later, 10).warm_sessions.is_empty());
    }
}
