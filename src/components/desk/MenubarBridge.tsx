// Mounted once in the main window. Publishes the desk snapshot to the menu bar popover,
// keeps the menu bar gauge in sync, and runs the actions the popover requests.

import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { useCoreRuntime } from '../../coreRuntime';
import { currentWindow } from '../../services/limits';
import { runRoutingTick, useRoutingState } from '../../services/routingController';
import {
  ACTION_EVENT,
  SNAPSHOT_EVENT,
  SNAPSHOT_REQUEST_EVENT,
  useBuildChannel,
  type DeskAction,
  type DeskSnapshot,
} from '../../services/deskSnapshot';

export function MenubarBridge({ onCoreCommand }: {
  onCoreCommand: (command: 'start_core_process' | 'restart_core_process') => void;
}) {
  const routing = useRoutingState();
  const { status } = useCoreRuntime();
  const channel = useBuildChannel();
  const portRef = useRef<number | null>(null);

  useEffect(() => {
    void invoke<{ port: number }>('get_gui_settings')
      .then((settings) => { portRef.current = settings.port; })
      .catch(() => undefined);
  }, [status?.running]);

  const snapshot = useMemo<DeskSnapshot>(() => ({
    channel,
    core: {
      ready: Boolean(status?.ready),
      running: Boolean(status?.running),
      starting: Boolean(status?.starting),
      version: status?.currentVersion ?? null,
    },
    port: portRef.current,
    accounts: routing.accounts,
    plan: routing.plan,
    warmSessions: routing.warmSessions.length,
    lastRunMs: routing.lastRunMs,
    lastError: routing.lastError,
  }), [channel, status, routing]);

  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(() => {
    void emit(SNAPSHOT_EVENT, snapshot);
    // The gauge shows the week of the account new sessions go to.
    const serving = snapshot.plan.find((entry) => entry.eligible)?.name;
    const week = currentWindow(snapshot.accounts.find((account) => account.name === serving)?.limits?.week, Date.now());
    void invoke('set_tray_gauge', { weekPct: week?.usedPct ?? null, running: snapshot.core.ready }).catch(() => undefined);
  }, [snapshot]);

  const commandRef = useRef(onCoreCommand);
  commandRef.current = onCoreCommand;

  useEffect(() => {
    const stops = [
      listen(SNAPSHOT_REQUEST_EVENT, () => { void emit(SNAPSHOT_EVENT, latest.current); }),
      listen<DeskAction>(ACTION_EVENT, ({ payload }) => {
        if (payload === 'refresh') void runRoutingTick(true);
        if (payload === 'start-core') commandRef.current('start_core_process');
        if (payload === 'restart-core') commandRef.current('restart_core_process');
      }),
    ];
    return () => { stops.forEach((stop) => void stop.then((unlisten) => unlisten())); };
  }, []);

  return null;
}
