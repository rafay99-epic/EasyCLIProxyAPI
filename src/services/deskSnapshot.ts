// Contract between the main window and the menu bar popover (a second webview).
// The main window owns all state and actions: it runs the routing controller, publishes a
// snapshot after every change, and performs the actions the popover asks for. The popover
// only renders snapshots, so it never duplicates polling or priority writes.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AccountLimits, PlannedAccount } from './limits';

export type BuildChannel = 'dev' | 'prod';

export type DeskSnapshot = {
  channel: BuildChannel;
  core: { ready: boolean; running: boolean; starting: boolean; version: string | null };
  port: number | null;
  accounts: AccountLimits[];
  plan: PlannedAccount[];
  warmSessions: number;
  lastRunMs: number | null;
  lastError: string | null;
};

export type DeskAction = 'refresh' | 'start-core' | 'restart-core';

export const SNAPSHOT_EVENT = 'desk-snapshot';
export const SNAPSHOT_REQUEST_EVENT = 'desk-snapshot-request';
export const ACTION_EVENT = 'desk-action';

let channelRequest: Promise<BuildChannel> | null = null;

/** The build channel never changes at runtime, so it's fetched once per window. */
export function useBuildChannel(): BuildChannel {
  const [channel, setChannel] = useState<BuildChannel>('prod');
  useEffect(() => {
    channelRequest ??= invoke<string>('get_build_channel')
      .then((value): BuildChannel => (value === 'dev' ? 'dev' : 'prod'))
      .catch((): BuildChannel => 'prod');
    void channelRequest.then(setChannel);
  }, []);
  return channel;
}
