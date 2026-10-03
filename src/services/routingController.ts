// App-wide controller that keeps Claude account priorities in reset-first order.
//
// It runs from App (not from a page) so routing stays correct while the window is hidden.
// Each tick: read credentials + passive rate-limit headers, refresh exact usage every few
// minutes, plan the order with `planRouting`, and PATCH `priority` only when it changed.
// Changing priority never drops a session pin in the core, so warm caches are untouched.

import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { authFileName, dedupeAuthFiles, isOAuthCredentialFile, parseAuthFilePriority } from './authFiles';
import { isRecord, managementApi, normalizeAuthIndex, readBoolean, readString, responseList } from './managementApi';
import { fetchClaudeUsagePayload, providerForFile } from './quotaService';
import { quotaResetInstant } from './quotaTime';
import {
  coolingUntilFrom,
  defaultRoutingSettings,
  detectRefill,
  limitsFromHeaderSignals,
  limitsFromUsagePayload,
  mergeLimits,
  planRouting,
  type AccountLimits,
  type LimitSnapshot,
  type PlannedAccount,
  type RoutingSettings,
  type WeekPoint,
} from './limits';

export type SessionMove = {
  at: string;
  session: string;
  model: string;
  toAccount: string;
  fromAccount: string | null;
  reason: string | null;
};

export type WarmSession = {
  session: string;
  account: string;
  model: string;
  lastSeen: string;
  warmSecondsLeft: number;
};

export type Refill = { name: string; atMs: number; resetsAtMs: number | null };

export type RoutingState = {
  accounts: AccountLimits[];
  plan: PlannedAccount[];
  settings: RoutingSettings;
  moves: SessionMove[];
  warmSessions: WarmSession[];
  refills: Refill[];
  history: Record<string, WeekPoint[]>;
  lastRunMs: number | null;
  lastError: string | null;
  busy: boolean;
};

const TICK_MS = 60_000;
const USAGE_REFRESH_MS = 5 * 60_000;
const HISTORY_LIMIT = 300;
const SETTINGS_KEY = 'cpa-desk.routing-settings';
const HISTORY_KEY = 'cpa-desk.week-history';

const readStored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};

const writeStored = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: routing still works, only history is lost.
  }
};

let state: RoutingState = {
  accounts: [],
  plan: [],
  settings: readStored(SETTINGS_KEY, defaultRoutingSettings),
  moves: [],
  warmSessions: [],
  refills: [],
  history: readStored<Record<string, WeekPoint[]>>(HISTORY_KEY, {}),
  lastRunMs: null,
  lastError: null,
  busy: false,
};

const listeners = new Set<() => void>();
const setState = (patch: Partial<RoutingState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const usageCache = new Map<string, { snapshot: LimitSnapshot | null; fetchedAtMs: number }>();

const isClaudeOAuth = (file: Record<string, unknown>) =>
  providerForFile(file) === 'claude' && isOAuthCredentialFile(file);

const accountLabel = (file: Record<string, unknown>) =>
  readString(file, 'email', 'account', 'label') || authFileName(file);

async function loadAccounts(forceUsage: boolean, nowMs: number): Promise<AccountLimits[]> {
  const payload = await managementApi.get('/auth-files');
  const files = dedupeAuthFiles(responseList(payload, 'files')).filter(isClaudeOAuth);
  const accounts: AccountLimits[] = [];
  for (const file of files) {
    const name = authFileName(file);
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    const disabled = readBoolean(file, 'disabled');
    const quota = isRecord(file.quota) ? file.quota : {};
    const headers = limitsFromHeaderSignals(quota.signals, quotaResetInstant(quota.observed_at) ?? nowMs);

    const cached = usageCache.get(name);
    let usage = cached?.snapshot ?? null;
    const stale = !cached || nowMs - cached.fetchedAtMs >= USAGE_REFRESH_MS;
    if (authIndex && !disabled && (forceUsage || stale)) {
      try {
        usage = limitsFromUsagePayload(await fetchClaudeUsagePayload(authIndex), nowMs);
      } catch {
        // Usage endpoint unreachable: fall back to the passive headers.
      }
      usageCache.set(name, { snapshot: usage, fetchedAtMs: nowMs });
    }

    accounts.push({
      name,
      label: accountLabel(file),
      authIndex,
      priority: parseAuthFilePriority(file.priority) ?? 0,
      disabled,
      coolingUntilMs: coolingUntilFrom(file, nowMs),
      limits: mergeLimits(headers, usage),
    });
  }
  return accounts;
}

/** Writes priorities that differ from the plan. Returns accounts with the new values. */
async function applyPlan(accounts: AccountLimits[], plan: PlannedAccount[]): Promise<AccountLimits[]> {
  const wanted = new Map(plan.map((entry) => [entry.name, entry.priority]));
  const next: AccountLimits[] = [];
  for (const account of accounts) {
    const priority = wanted.get(account.name);
    if (priority !== undefined && priority !== account.priority) {
      await managementApi.patch('/auth-files/fields', { name: account.name, priority });
      next.push({ ...account, priority });
    } else {
      next.push(account);
    }
  }
  return next;
}

function recordHistory(accounts: AccountLimits[], nowMs: number) {
  const history = { ...state.history };
  for (const account of accounts) {
    const week = account.limits?.week;
    if (!week) continue;
    const points = (history[account.name] ?? []).filter((point) => point.resetsAtMs === week.resetsAtMs);
    const last = points[points.length - 1];
    if (!last || last.usedPct !== week.usedPct || nowMs - last.atMs >= 30 * 60_000) {
      points.push({ atMs: nowMs, usedPct: week.usedPct, resetsAtMs: week.resetsAtMs });
    }
    history[account.name] = points.slice(-HISTORY_LIMIT);
  }
  writeStored(HISTORY_KEY, history);
  return history;
}

function findRefills(previous: AccountLimits[], next: AccountLimits[], nowMs: number): Refill[] {
  const before = new Map(previous.map((account) => [account.name, account]));
  const found = next.flatMap((account) => {
    const old = before.get(account.name);
    const week = account.limits?.week;
    return old && detectRefill(old.limits?.week, week)
      ? [{ name: account.name, atMs: nowMs, resetsAtMs: week?.resetsAtMs ?? null }]
      : [];
  });
  // Keep refills until their window resets, newest first.
  return [...found, ...state.refills]
    .filter((refill) => refill.resetsAtMs === null || refill.resetsAtMs > nowMs)
    .slice(0, 10);
}

let inFlight: Promise<void> | null = null;

/** One controller pass. `forceUsage` refreshes exact usage for every account. */
export function runRoutingTick(forceUsage = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    setState({ busy: true });
    const nowMs = Date.now();
    try {
      let accounts = await loadAccounts(forceUsage, nowMs);
      const plan = planRouting(accounts, state.settings, nowMs);
      if (state.settings.auto) {
        accounts = await applyPlan(accounts, plan);
      }
      const activity = await invoke<{ moves: SessionMove[]; warmSessions: WarmSession[] }>(
        'read_session_activity',
        { limit: 30 },
      ).catch(() => ({ moves: state.moves, warmSessions: state.warmSessions }));
      setState({
        accounts,
        plan,
        moves: activity.moves,
        warmSessions: activity.warmSessions,
        refills: findRefills(state.accounts, accounts, nowMs),
        history: recordHistory(accounts, nowMs),
        lastRunMs: nowMs,
        lastError: null,
      });
    } catch (error) {
      setState({ lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      setState({ busy: false });
      inFlight = null;
    }
  })();
  return inFlight;
}

export function updateRoutingSettings(patch: Partial<RoutingSettings>) {
  const settings = { ...state.settings, ...patch };
  writeStored(SETTINGS_KEY, settings);
  setState({ settings, plan: planRouting(state.accounts, settings, Date.now()) });
  void runRoutingTick();
}

export function useRoutingState(): RoutingState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Mount once at the app root. Runs the controller while the core is ready. */
export function useRoutingController(coreReady: boolean) {
  useEffect(() => {
    if (!coreReady) return undefined;
    void runRoutingTick(true);
    const timer = window.setInterval(() => void runRoutingTick(), TICK_MS);
    return () => window.clearInterval(timer);
  }, [coreReady]);
}
