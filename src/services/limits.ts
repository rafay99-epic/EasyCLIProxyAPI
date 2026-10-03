// Claude subscription limits and reset-aware routing.
//
// Two data sources feed the same model:
//  - the OAuth usage endpoint (exact 5h / weekly / Fable-weekly windows, fetched on demand)
//  - the passive `anthropic-ratelimit-unified-*` headers the core records on every response
// `planRouting` turns them into account priorities: burn the account whose weekly window
// resets soonest, skip accounts close to their 5h limit, and never reorder for any other reason.
// Pinned sessions ignore priority in the core, so a new order only affects new sessions and
// sessions idle long enough that their prompt cache is already gone.

import { isRecord, readNumber, readString } from './managementApi';
import { quotaResetInstant } from './quotaTime';

export type LimitWindowId = 'fiveHour' | 'week' | 'fableWeek';

export type LimitWindow = {
  /** Percent of the window already used, 0 to 100. */
  usedPct: number;
  /** When the window resets, epoch ms. */
  resetsAtMs: number | null;
};

export type LimitSnapshot = Partial<Record<LimitWindowId, LimitWindow>> & {
  observedAtMs: number;
  source: 'usage' | 'headers';
};

export type AccountLimits = {
  /** Auth file name; the id the core uses for PATCH /auth-files/fields. */
  name: string;
  label: string;
  authIndex: string;
  priority: number;
  disabled: boolean;
  coolingUntilMs: number | null;
  limits: LimitSnapshot | null;
};

export type BurnWindow = 'week' | 'fableWeek';

export type RoutingSettings = {
  /** When off, the plan is shown but priorities are never written. */
  auto: boolean;
  /** automatic: reset-first order. manual: `manualOrder` is used as is. */
  mode: 'automatic' | 'manual';
  /** Auth file names, first = highest priority. Unknown accounts follow in automatic order. */
  manualOrder: string[];
  /** New sessions skip an account once its 5h window is at or above this percent. */
  headroomPct: number;
  /**
   * New sessions skip an account once its burn window is at or above this percent.
   * A session started on a nearly capped account would be force-moved within minutes
   * and pay a full cache rewrite, so the last few percent are left to warm sessions.
   */
  weeklyCutoffPct: number;
  burnWindow: BurnWindow;
};

export const defaultRoutingSettings: RoutingSettings = {
  auto: true,
  mode: 'automatic',
  manualOrder: [],
  headroomPct: 85,
  weeklyCutoffPct: 95,
  burnWindow: 'week',
};

export type PlanStatus = 'ready' | 'unknown' | 'near-5h' | 'near-week' | 'capped' | 'cooling' | 'disabled';

export type PlannedAccount = {
  name: string;
  priority: number;
  eligible: boolean;
  status: PlanStatus;
  /** When an ineligible account becomes usable again, if known. */
  backAtMs: number | null;
  reason: string;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const clampPct = (value: number) => Math.max(0, Math.min(100, value));

const usageWindow = (raw: unknown, usedKey = 'utilization'): LimitWindow | undefined => {
  if (!isRecord(raw)) return undefined;
  const used = readNumber(raw, usedKey);
  if (used === null) return undefined;
  return {
    usedPct: clampPct(used),
    resetsAtMs: quotaResetInstant(raw.resets_at ?? raw.resetsAt) ?? null,
  };
};

/** Parses the body of GET https://api.anthropic.com/api/oauth/usage. */
export function limitsFromUsagePayload(payload: unknown, observedAtMs: number): LimitSnapshot | null {
  const body = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!isRecord(body)) return null;
  const fableLimits = (Array.isArray(body.limits) ? body.limits : []).filter(isRecord).filter((limit) => {
    const scope = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model : null;
    const model = readString(scope, 'display_name', 'displayName').toLowerCase();
    return readString(limit, 'kind').toLowerCase() === 'weekly_scoped' && model.startsWith('fable');
  });
  const fableLimit = fableLimits.find((limit) => limit.is_active === true) ?? fableLimits[0];
  const snapshot: LimitSnapshot = {
    observedAtMs,
    source: 'usage',
    fiveHour: usageWindow(body.five_hour),
    week: usageWindow(body.seven_day),
    fableWeek: fableLimit ? usageWindow(fableLimit, 'percent') : usageWindow(body.iguana_necktie),
  };
  return snapshot.fiveHour || snapshot.week || snapshot.fableWeek ? snapshot : null;
}

const HEADER_PREFIX = 'anthropic-ratelimit-unified-';
const headerWindows: Record<LimitWindowId, string> = {
  fiveHour: '5h',
  week: '7d',
  fableWeek: '7d_oi',
};

/** Parses the `quota.signals` map the core keeps from the last Claude response headers. */
export function limitsFromHeaderSignals(signals: unknown, observedAtMs: number): LimitSnapshot | null {
  if (!isRecord(signals)) return null;
  const lower = new Map(Object.entries(signals).map(([key, value]) => [key.toLowerCase(), value]));
  const read = (id: LimitWindowId): LimitWindow | undefined => {
    const key = `${HEADER_PREFIX}${headerWindows[id]}`;
    const utilization = Number(lower.get(`${key}-utilization`));
    if (!Number.isFinite(utilization)) return undefined;
    return {
      // Headers report a 0..1 fraction.
      usedPct: clampPct(utilization * 100),
      resetsAtMs: quotaResetInstant(lower.get(`${key}-reset`)) ?? null,
    };
  };
  const snapshot: LimitSnapshot = {
    observedAtMs,
    source: 'headers',
    fiveHour: read('fiveHour'),
    week: read('week'),
    fableWeek: read('fableWeek'),
  };
  return snapshot.fiveHour || snapshot.week || snapshot.fableWeek ? snapshot : null;
}

/** Window by window, keeps whichever snapshot is newer. */
export function mergeLimits(a: LimitSnapshot | null, b: LimitSnapshot | null): LimitSnapshot | null {
  if (!a || !b) return a ?? b;
  const [older, newer] = a.observedAtMs <= b.observedAtMs ? [a, b] : [b, a];
  return {
    observedAtMs: newer.observedAtMs,
    source: newer.source,
    fiveHour: newer.fiveHour ?? older.fiveHour,
    week: newer.week ?? older.week,
    fableWeek: newer.fableWeek ?? older.fableWeek,
  };
}

/** A window whose reset time has passed is effectively empty again. */
export function currentWindow(window: LimitWindow | undefined, nowMs: number): LimitWindow | undefined {
  if (!window) return undefined;
  if (window.resetsAtMs !== null && window.resetsAtMs <= nowMs) {
    return { usedPct: 0, resetsAtMs: null };
  }
  return window;
}

const formatReset = (ms: number | null, nowMs: number) => {
  if (ms === null) return 'reset unknown';
  const date = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
};

/**
 * Orders Claude accounts for new sessions. Highest priority number is used first by the
 * core's fill-first selector, so the result counts down from N to 1.
 */
export function planRouting(
  accounts: AccountLimits[],
  settings: RoutingSettings,
  nowMs: number,
): PlannedAccount[] {
  type Ranked = PlannedAccount & { group: number; sortKey: number; tieKey: number };
  const ranked = accounts.map((account): Ranked => {
    const fiveHour = currentWindow(account.limits?.fiveHour, nowMs);
    const week = currentWindow(account.limits?.week, nowMs);
    const fable = currentWindow(account.limits?.fableWeek, nowMs);
    const burn = settings.burnWindow === 'fableWeek' ? fable ?? week : week;
    const base = { name: account.name, priority: 0, backAtMs: null };

    if (account.disabled) {
      return { ...base, eligible: false, status: 'disabled', reason: 'disabled', group: 4, sortKey: 0, tieKey: 0 };
    }
    if (account.coolingUntilMs !== null && account.coolingUntilMs > nowMs) {
      return {
        ...base,
        eligible: false,
        status: 'cooling',
        backAtMs: account.coolingUntilMs,
        reason: `cooling until ${formatReset(account.coolingUntilMs, nowMs)}`,
        group: 3,
        sortKey: account.coolingUntilMs,
        tieKey: 0,
      };
    }
    const capped = [week, fable].find((window) => window && window.usedPct >= 100);
    if (capped) {
      return {
        ...base,
        eligible: false,
        status: 'capped',
        backAtMs: capped.resetsAtMs,
        reason: `weekly limit reached, resets ${formatReset(capped.resetsAtMs, nowMs)}`,
        group: 3,
        sortKey: capped.resetsAtMs ?? Number.MAX_SAFE_INTEGER,
        tieKey: 0,
      };
    }
    if (burn && burn.usedPct >= settings.weeklyCutoffPct) {
      return {
        ...base,
        eligible: false,
        status: 'near-week',
        backAtMs: burn.resetsAtMs,
        reason: `week at ${Math.round(burn.usedPct)}%, kept for warm sessions until ${formatReset(burn.resetsAtMs, nowMs)}`,
        group: 2,
        sortKey: burn.resetsAtMs ?? Number.MAX_SAFE_INTEGER,
        tieKey: 0,
      };
    }
    if (fiveHour && fiveHour.usedPct >= settings.headroomPct) {
      return {
        ...base,
        eligible: false,
        status: 'near-5h',
        backAtMs: fiveHour.resetsAtMs,
        reason: `5h at ${Math.round(fiveHour.usedPct)}%, resets ${formatReset(fiveHour.resetsAtMs, nowMs)}`,
        group: 2,
        sortKey: fiveHour.resetsAtMs ?? Number.MAX_SAFE_INTEGER,
        tieKey: 0,
      };
    }
    if (!burn) {
      return { ...base, eligible: true, status: 'unknown', reason: 'no limit data yet', group: 1, sortKey: 0, tieKey: 0 };
    }
    const label = settings.burnWindow === 'fableWeek' && fable ? 'Fable week' : 'week';
    return {
      ...base,
      eligible: true,
      status: 'ready',
      reason: `${label} resets ${formatReset(burn.resetsAtMs, nowMs)}, ${Math.round(100 - burn.usedPct)}% left`,
      group: 0,
      sortKey: burn.resetsAtMs ?? Number.MAX_SAFE_INTEGER,
      // More left at the same reset burns first.
      tieKey: burn.usedPct,
    };
  });

  ranked.sort((left, right) =>
    left.group - right.group
    || left.sortKey - right.sortKey
    || left.tieKey - right.tieKey
    || left.name.localeCompare(right.name));

  if (settings.mode === 'manual') {
    // The user's order wins; accounts they haven't placed keep their automatic order after it.
    const position = new Map(settings.manualOrder.map((name, index) => [name, index]));
    const automatic = new Map(ranked.map((entry, index) => [entry.name, index]));
    ranked.sort((left, right) =>
      (position.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.name) ?? Number.MAX_SAFE_INTEGER)
      || (automatic.get(left.name) ?? 0) - (automatic.get(right.name) ?? 0));
  }

  return ranked.map(({ group: _group, sortKey: _sortKey, tieKey: _tieKey, ...planned }, index) => ({
    ...planned,
    priority: ranked.length - index,
  }));
}

export type WeekPoint = { atMs: number; usedPct: number; resetsAtMs: number | null };

export type BurnProjection = {
  /** Percent of the window expected to expire unused, or null without enough history. */
  leftAtResetPct: number | null;
  pace: 'ahead' | 'on pace' | 'behind' | null;
};

/**
 * Projects how much of a weekly window will go unused. Uses the burn rate across the last
 * 24h of snapshots taken within the same window (same reset time).
 */
export function projectBurn(history: WeekPoint[], window: LimitWindow | undefined, nowMs: number): BurnProjection {
  if (!window || window.resetsAtMs === null || window.resetsAtMs <= nowMs) {
    return { leftAtResetPct: null, pace: null };
  }
  const resetsAtMs = window.resetsAtMs;
  const startMs = resetsAtMs - WEEK_MS;
  const expectedUsed = clampPct(((nowMs - startMs) / WEEK_MS) * 100);
  const gap = window.usedPct - expectedUsed;
  const pace = gap > 5 ? 'ahead' : gap < -5 ? 'behind' : 'on pace';

  const sameWindow = history
    .filter((point) => point.resetsAtMs === resetsAtMs && point.atMs >= nowMs - 24 * 60 * 60 * 1000)
    .sort((left, right) => left.atMs - right.atMs);
  const first = sameWindow[0];
  if (!first || nowMs - first.atMs < 30 * 60 * 1000) {
    return { leftAtResetPct: null, pace };
  }
  const ratePerMs = Math.max(0, window.usedPct - first.usedPct) / (nowMs - first.atMs);
  const projectedUsed = clampPct(window.usedPct + ratePerMs * (resetsAtMs - nowMs));
  return { leftAtResetPct: Math.round(100 - projectedUsed), pace };
}

/**
 * Claude refills limits by resetting the percentage while keeping the reset timer.
 * A large drop with an unchanged reset time is that kind of free refill.
 */
export function detectRefill(previous: LimitWindow | undefined, next: LimitWindow | undefined): boolean {
  if (!previous || !next || previous.resetsAtMs === null) return false;
  return previous.resetsAtMs === next.resetsAtMs && previous.usedPct - next.usedPct >= 20;
}

/**
 * Latest credential-wide cooldown end from the core's `cooldowns` list
 * (`{ scope, retry_at, remaining_seconds }`). Model-scoped cooldowns don't take the
 * whole account out of rotation, so they're ignored here.
 */
export function coolingUntilFrom(file: Record<string, unknown>, nowMs: number): number | null {
  const cooldowns = Array.isArray(file.cooldowns) ? file.cooldowns.filter(isRecord) : [];
  const ends = cooldowns
    .filter((cooldown) => readString(cooldown, 'scope').toLowerCase() !== 'model')
    .map((cooldown) => {
      const remaining = readNumber(cooldown, 'remaining_seconds');
      return quotaResetInstant(cooldown.retry_at) ?? (remaining === null ? undefined : nowMs + remaining * 1000);
    })
    .filter((ms): ms is number => ms !== undefined && ms > nowMs);
  return ends.length ? Math.max(...ends) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
