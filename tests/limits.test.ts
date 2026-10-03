// Run with: bun test tests/limits.test.ts
import { describe, expect, test } from 'bun:test';
import {
  defaultRoutingSettings,
  detectRefill,
  limitsFromHeaderSignals,
  limitsFromUsagePayload,
  planRouting,
  projectBurn,
  type AccountLimits,
} from '../src/services/limits';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-03T12:00:00Z');

const account = (name: string, limits: AccountLimits['limits'], extra: Partial<AccountLimits> = {}): AccountLimits => ({
  name,
  label: name,
  authIndex: name,
  priority: 0,
  disabled: false,
  coolingUntilMs: null,
  limits,
  ...extra,
});

const windows = (fiveHourPct: number, weekPct: number, weekResetInHours: number) => ({
  observedAtMs: now,
  source: 'usage' as const,
  fiveHour: { usedPct: fiveHourPct, resetsAtMs: now + 2 * HOUR },
  week: { usedPct: weekPct, resetsAtMs: now + weekResetInHours * HOUR },
});

describe('parsing', () => {
  test('usage endpoint gives 5h, week and the Fable weekly bucket', () => {
    const snapshot = limitsFromUsagePayload({
      five_hour: { utilization: 20, resets_at: '2026-10-03T15:50:00Z' },
      seven_day: { utilization: 10, resets_at: '2026-10-09T18:00:00Z' },
      limits: [{ kind: 'weekly_scoped', percent: 6, is_active: true, scope: { model: { display_name: 'Fable' } }, resets_at: '2026-10-09T18:00:00Z' }],
    }, now);
    expect(snapshot?.fiveHour).toEqual({ usedPct: 20, resetsAtMs: Date.parse('2026-10-03T15:50:00Z') });
    expect(snapshot?.week?.usedPct).toBe(10);
    expect(snapshot?.fableWeek?.usedPct).toBe(6);
  });

  test('rate-limit headers are 0..1 fractions with unix-second resets', () => {
    const snapshot = limitsFromHeaderSignals({
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.2',
      'Anthropic-Ratelimit-Unified-5h-Reset': '1791024600',
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0.1',
    }, now);
    expect(snapshot?.fiveHour).toEqual({ usedPct: 20, resetsAtMs: 1791024600 * 1000 });
    expect(snapshot?.week).toEqual({ usedPct: 10, resetsAtMs: null });
    expect(snapshot?.fableWeek).toBeUndefined();
  });
});

describe('planRouting', () => {
  test('burns the account whose weekly window resets soonest first', () => {
    const plan = planRouting([
      account('saturday', windows(0, 64, 30)),
      account('friday', windows(20, 10, 6)),
    ], defaultRoutingSettings, now);
    expect(plan.map((entry) => [entry.name, entry.priority])).toEqual([['friday', 2], ['saturday', 1]]);
  });

  test('an account at the 5h headroom drops below every eligible account', () => {
    const plan = planRouting([
      account('hot', windows(90, 10, 6)),
      account('cool', windows(10, 50, 40)),
    ], defaultRoutingSettings, now);
    expect(plan[0].name).toBe('cool');
    expect(plan[1]).toMatchObject({ name: 'hot', eligible: false });
  });

  test('weekly cap, cooldown and disabled accounts sort last', () => {
    const plan = planRouting([
      account('off', windows(0, 0, 10), { disabled: true }),
      account('capped', windows(0, 100, 10)),
      account('fresh', null),
      account('ok', windows(0, 30, 50)),
    ], defaultRoutingSettings, now);
    expect(plan.map((entry) => entry.name)).toEqual(['ok', 'fresh', 'capped', 'off']);
    expect(plan.map((entry) => entry.priority)).toEqual([4, 3, 2, 1]);
  });

  test('a window past its reset time counts as empty again', () => {
    const stale = { ...windows(95, 100, -1), fiveHour: { usedPct: 95, resetsAtMs: now - HOUR } };
    const [entry] = planRouting([account('rolled', stale)], defaultRoutingSettings, now);
    expect(entry.eligible).toBe(true);
  });
});

describe('burn signals', () => {
  test('a large drop with the same reset time is a refill', () => {
    const reset = now + 30 * HOUR;
    expect(detectRefill({ usedPct: 70, resetsAtMs: reset }, { usedPct: 0, resetsAtMs: reset })).toBe(true);
    expect(detectRefill({ usedPct: 70, resetsAtMs: reset }, { usedPct: 0, resetsAtMs: reset + 7 * 24 * HOUR })).toBe(false);
  });

  test('projects unused share from the last day of burn', () => {
    const resetsAtMs = now + 24 * HOUR;
    const projection = projectBurn(
      [{ atMs: now - 10 * HOUR, usedPct: 40, resetsAtMs }],
      { usedPct: 50, resetsAtMs },
      now,
    );
    // 10 points in 10h, 24h left: ends near 74% used, so about 26% expires.
    expect(projection.leftAtResetPct).toBe(26);
    expect(projection.pace).toBe('behind');
  });
});

describe('cooldowns', () => {
  test('only credential-wide cooldowns take an account out of rotation', async () => {
    const { coolingUntilFrom } = await import('../src/services/limits');
    const retry = new Date(now + HOUR).toISOString();
    expect(coolingUntilFrom({ cooldowns: [{ scope: 'model', retry_at: retry }] }, now)).toBeNull();
    expect(coolingUntilFrom({ cooldowns: [{ scope: 'credential', retry_at: retry }] }, now)).toBe(now + HOUR);
  });
});

describe('weekly cutoff', () => {
  test('a nearly capped account is kept for warm sessions, not new ones', () => {
    // Real snapshot from 2026-10-03: weekend 98% weekly resetting tonight,
    // primary 12% resetting Friday, backend at its 5h limit.
    const plan = planRouting([
      account('weekend', windows(1, 98, 7)),
      account('primary', windows(1, 12, 144)),
      account('backend', windows(100, 34, 159)),
    ], defaultRoutingSettings, now);
    // backend's 5h reopens before weekend's nearly spent week resets, so it is the better fallback.
    expect(plan.map((entry) => entry.name)).toEqual(['primary', 'backend', 'weekend']);
    expect(plan[2]).toMatchObject({ eligible: false });
    expect(plan[2].reason).toContain('kept for warm sessions');
  });
});

describe('manual order', () => {
  test('manual mode keeps the user order and appends unplaced accounts in automatic order', () => {
    const accounts = [
      account('weekend', windows(1, 98, 7)),
      account('primary', windows(1, 12, 144)),
      account('backend', windows(100, 34, 159)),
    ];
    const plan = planRouting(accounts, { ...defaultRoutingSettings, mode: 'manual', manualOrder: ['backend', 'weekend'] }, now);
    expect(plan.map((entry) => [entry.name, entry.priority])).toEqual([['backend', 3], ['weekend', 2], ['primary', 1]]);
    expect(plan[0].reason).toContain('5h at 100%');
  });
});
