// In-app updates from this fork's GitHub Releases. The backend (src-tauri/src/updates.rs)
// checks, downloads and verifies; the UI shows status and triggers the restart.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error';

export type UpdateStatus = {
  phase: UpdatePhase;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  publishedAt: string | null;
  progress: number | null;
  checkedAtMs: number | null;
  error: string | null;
};

const UPDATE_STATUS_EVENT = 'desk-update-status';

export function useDeskUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installError, setInstallError] = useState('');

  useEffect(() => {
    void invoke<UpdateStatus>('get_update_status').then(setStatus).catch(() => setStatus(null));
    const stop = listen<UpdateStatus>(UPDATE_STATUS_EVENT, ({ payload }) => setStatus(payload));
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);

  const check = async () => {
    try {
      setStatus(await invoke<UpdateStatus>('check_for_update'));
    } catch {
      // Failures arrive as an "error" status event.
    }
  };

  const install = async () => {
    setInstallError('');
    try {
      await invoke('install_update_and_restart');
    } catch (cause) {
      setInstallError(String(cause));
    }
  };

  return { status, check, install, installError, ready: status?.phase === 'ready' };
}

/** One line for status rows: "Up to date", "Downloading 1.1.0 · 40%", and so on. */
export function updateSummary(status: UpdateStatus | null): string {
  if (!status) return 'Updates unavailable';
  switch (status.phase) {
    case 'checking': return 'Checking for updates';
    case 'downloading': return `Downloading ${status.version ?? 'update'}${status.progress !== null ? ` · ${status.progress}%` : ''}`;
    case 'ready': return `Version ${status.version} is ready`;
    case 'up-to-date': return 'Up to date';
    case 'error': return status.error ?? 'Update check failed';
    case 'idle': return 'Not checked yet';
  }
}
