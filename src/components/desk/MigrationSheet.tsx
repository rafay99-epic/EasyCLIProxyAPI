// One-time import from the production EasyCLIProxyAPI install. The sheet keeps checking
// that production is fully quit, shows what will move, then imports and restarts.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sheet } from './Sheet';

export type MigrationStatus = {
  available: boolean;
  productionDir: string;
  productionProcesses: string[];
  migratedAt: string | null;
  credentials: number;
  usageBytes: number;
  port: number | null;
};

type MigrationReport = { copied: string[]; backupDir: string };

/** Loads the import status once; `null` until known or when the command is missing. */
export function useMigrationStatus() {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<MigrationStatus>('get_migration_status'));
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { status, refresh };
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export function MigrationSheet({ onClose }: { onClose: () => void }) {
  const { status, refresh } = useMigrationStatus();
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState('');

  // Keep checking while the user quits production in another window.
  useEffect(() => {
    if (phase !== 'idle') return undefined;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [phase, refresh]);

  const running = status?.productionProcesses ?? [];
  const blocked = !status?.available || running.length > 0 || Boolean(status?.migratedAt);

  const start = async () => {
    setPhase('running');
    setError('');
    try {
      setReport(await invoke<MigrationReport>('run_production_migration'));
      setPhase('done');
    } catch (cause) {
      setError(String(cause));
      setPhase('idle');
      void refresh();
    }
  };

  return (
    <Sheet
      title="Import from EasyCLIProxyAPI"
      subtitle="Moves your accounts, keys and settings into CPA Desk. Runs once."
      onClose={phase === 'running' ? () => undefined : onClose}
      footer={phase === 'done' ? (
        <button type="button" className="d-btn d-primary" style={{ marginLeft: 'auto' }} onClick={() => void invoke('restart_after_migration')}>
          Restart CPA Desk
        </button>
      ) : (
        <>
          <button type="button" className="d-btn" disabled={phase === 'running'} onClick={onClose}>Cancel</button>
          <button type="button" className="d-btn d-primary" style={{ marginLeft: 'auto' }} disabled={blocked || phase === 'running'} onClick={() => void start()}>
            {phase === 'running' ? 'Importing' : 'Import'}
          </button>
        </>
      )}
    >
      {error ? <div className="d-notice d-bad">{error}</div> : null}

      {phase === 'done' && report ? (
        <>
          <div className="d-notice d-ok"><span>Imported. Restart to start serving on port {status?.port ?? 8317} with your accounts.</span></div>
          <dl className="d-kv">
            <dt>Copied</dt><dd>{report.copied.join(', ')}</dd>
            <dt>Client configs</dt><dd>Real ~/.claude and ~/.codex (sandbox off)</dd>
            <dt>Previous CPA Desk data</dt><dd className="d-mono">{report.backupDir}</dd>
          </dl>
          <p className="d-help" style={{ marginTop: 16 }}>Don't open EasyCLIProxyAPI again. Its copy of your account tokens is now out of date.</p>
        </>
      ) : !status ? (
        <p className="d-t3">Checking</p>
      ) : status.migratedAt ? (
        <div className="d-notice"><span>Already imported on {status.migratedAt}.</span></div>
      ) : !status.available ? (
        <div className="d-notice"><span>No EasyCLIProxyAPI data found on this Mac.</span></div>
      ) : (
        <>
          <div className="d-title" style={{ marginTop: 0 }}><h2>Before you start</h2></div>
          <dl className="d-kv">
            <dt>EasyCLIProxyAPI</dt>
            <dd>
              {running.length
                ? <span className="d-badge d-bad">Still running: {running.join(', ')}</span>
                : <span className="d-badge d-ok">Quit</span>}
            </dd>
          </dl>
          {running.length ? (
            <p className="d-help" style={{ marginTop: 8 }}>Quit it from its menu bar icon. Both apps can't hold the same Claude accounts.</p>
          ) : null}

          <div className="d-title"><h2>What moves</h2></div>
          <dl className="d-kv">
            <dt>Accounts</dt><dd className="d-num">{status.credentials} credential files</dd>
            <dt>Port and API keys</dt><dd className="d-num">Port {status.port ?? 'unknown'}, same keys, so your clients keep working</dd>
            <dt>Settings</dt><dd>Providers, model aliases, prompt filters, routing</dd>
            <dt>Usage history</dt><dd className="d-num">{megabytes(status.usageBytes)}</dd>
            <dt>Client configs</dt><dd>Sandbox turns off; CPA Desk manages your real ~/.claude and ~/.codex</dd>
          </dl>

          <div className="d-title"><h2>Safety</h2></div>
          <p className="d-help">
            EasyCLIProxyAPI's files are only read, never changed. CPA Desk's current data is moved to a backup folder.
            You can turn the sandbox back on from Clients.
          </p>
        </>
      )}
    </Sheet>
  );
}
