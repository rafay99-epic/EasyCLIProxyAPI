// Menu bar popover (window label "tray"). Renders snapshots from the main window and
// sends actions back to it; launch at login, open and quit go straight to the backend.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { RefreshCw } from 'lucide-react';
import { clockText, MiniWindow, PlanBadge, shortName, useNow } from './components/desk/ui';
import { useDeskUpdate } from './services/deskUpdate';
import {
  ACTION_EVENT,
  SNAPSHOT_EVENT,
  SNAPSHOT_REQUEST_EVENT,
  type DeskAction,
  type DeskSnapshot,
} from './services/deskSnapshot';

type SoftwareSettings = {
  closeBehavior: string;
  autostartEnabled: boolean;
  startCoreOnLaunch: boolean;
  silentStartEnabled: boolean;
  defaultTerminal: string;
};

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null);
  useEffect(() => {
    const stop = listen<DeskSnapshot>(SNAPSHOT_EVENT, ({ payload }) => setSnapshot(payload));
    void emit(SNAPSHOT_REQUEST_EVENT);
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);
  return snapshot;
}

/** Launch at login also turns on start hidden, so login brings up the menu bar only. */
function useLaunchAtLogin() {
  const [settings, setSettings] = useState<SoftwareSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void invoke<SoftwareSettings>('get_software_settings').then(setSettings).catch(() => setSettings(null));
  }, []);
  const toggle = async () => {
    if (!settings) return;
    const enabled = !settings.autostartEnabled;
    try {
      setSettings(await invoke<SoftwareSettings>('save_software_settings', {
        settings: {
          closeBehavior: settings.closeBehavior,
          autostartEnabled: enabled,
          startCoreOnLaunch: settings.startCoreOnLaunch,
          silentStartEnabled: enabled || settings.silentStartEnabled,
          defaultTerminal: settings.defaultTerminal,
        },
      }));
      setError('');
    } catch (cause) {
      setError(String(cause));
    }
  };
  return { enabled: settings?.autostartEnabled ?? false, ready: Boolean(settings), toggle, error };
}

export function TrayPanel() {
  const snapshot = useSnapshot();
  const login = useLaunchAtLogin();
  const update = useDeskUpdate();
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // The native window follows the content height.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const report = () => { void invoke('resize_tray_panel', { height: panel.offsetHeight }).catch(() => undefined); };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const act = (action: DeskAction) => { void emit(ACTION_EVENT, action); };
  const baseUrl = snapshot?.port ? `http://127.0.0.1:${snapshot.port}` : '';
  const copyUrl = async () => {
    if (!baseUrl) return;
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const core = snapshot?.core;
  const tone = core?.ready ? 'd-ok' : core?.starting || core?.running ? 'd-warn' : 'd-bad';
  const coreLabel = !snapshot ? 'Connecting' : core?.ready ? 'Core running' : core?.starting ? 'Core starting' : core?.running ? 'Core not ready' : 'Core stopped';
  const servingName = snapshot?.plan.find((entry) => entry.eligible)?.name;
  const byName = new Map(snapshot?.accounts.map((account) => [account.name, account]) ?? []);
  const isDev = snapshot?.channel === 'dev';

  return (
    <div className="d-root d-tray-root">
      <div className="d-tray" ref={panelRef}>
        <div className="d-tray-h">
          <span className={`d-dot ${tone}`} />
          <b>{coreLabel}</b>
          {snapshot?.port ? <span className="d-t3 d-num">{snapshot.port}</span> : null}
          {isDev ? <span className="d-tray-dev">DEV</span> : null}
          <span className="d-t3 d-num d-tray-upd">{snapshot?.lastRunMs ? clockText(snapshot.lastRunMs, now) : ''}</span>
          <button type="button" className="d-iconbtn" aria-label="Refresh limits" disabled={!core?.ready} onClick={() => act('refresh')}>
            <RefreshCw className="d-icon" aria-hidden="true" />
          </button>
        </div>

        {update.ready ? (
          <div className="d-tray-update">
            <span className="d-badge d-ok">CPA Desk {update.status?.version} is ready</span>
            <button type="button" className="d-btn d-primary" onClick={() => void update.install()}>Restart</button>
          </div>
        ) : null}
        {update.installError ? <div className="d-tray-msg d-bad">{update.installError}</div> : null}
        {snapshot?.lastError ? <div className="d-tray-msg d-bad">{snapshot.lastError}</div> : null}

        {snapshot && snapshot.plan.length ? (
          <div className="d-tray-list">
            <div className="d-tray-row d-head"><span>Account</span><span>5 hour</span><span>Week</span></div>
            {snapshot.plan.map((entry) => {
              const account = byName.get(entry.name);
              if (!account) return null;
              return (
                <div key={entry.name} className="d-tray-row">
                  <span className="d-who">
                    <b>{shortName(account.label)}</b>
                    <PlanBadge entry={entry} serving={entry.name === servingName} now={now} />
                  </span>
                  <MiniWindow window={account.limits?.fiveHour} now={now} label="5h" />
                  <MiniWindow window={account.limits?.week} now={now} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="d-tray-msg d-t3">
            {!snapshot ? 'Waiting for CPA Desk' : core?.ready ? 'No Claude accounts yet' : 'Start the core to see limits'}
          </div>
        )}

        {snapshot && snapshot.warmSessions ? (
          <div className="d-tray-msg d-t3">{snapshot.warmSessions} warm session{snapshot.warmSessions === 1 ? '' : 's'} in the last hour</div>
        ) : null}

        {!isDev ? (
          <label className="d-tray-login">
            <span>Launch at login</span>
            <button type="button" className="d-switch" role="switch" aria-checked={login.enabled} aria-label="Launch at login"
              disabled={!login.ready} onClick={() => void login.toggle()} />
          </label>
        ) : null}
        {login.error ? <div className="d-tray-msg d-bad">{login.error}</div> : null}

        <div className="d-tray-f">
          <button type="button" className="d-btn d-primary" onClick={() => void invoke('open_main_window')}>Open</button>
          <button type="button" className="d-btn" disabled={!baseUrl} onClick={() => void copyUrl()}>{copied ? 'Copied' : 'Copy URL'}</button>
          {core?.running
            ? <button type="button" className="d-btn" onClick={() => act('restart-core')}>Restart core</button>
            : <button type="button" className="d-btn" disabled={!snapshot} onClick={() => act('start-core')}>Start core</button>}
          <button type="button" className="d-btn d-tray-quit" onClick={() => void invoke('quit_app')}>Quit</button>
        </div>
      </div>
    </div>
  );
}
