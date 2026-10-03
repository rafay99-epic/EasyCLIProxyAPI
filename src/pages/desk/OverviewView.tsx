// Overview: where new sessions go right now, the account order (automatic by weekly
// reset, or dragged by hand), and recent session activity. All data comes from the
// app-wide routing controller, which keeps running while this page is closed.

import { useMemo, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { GripVertical, RefreshCw } from 'lucide-react';
import { useCoreRuntime } from '../../coreRuntime';
import { useDeskNav } from '../../deskNav';
import { currentWindow, projectBurn, type AccountLimits, type LimitWindowId } from '../../services/limits';
import { runRoutingTick, updateRoutingSettings, useRoutingState, type RoutingState } from '../../services/routingController';
import { clockText, leftText, Meter, MiniWindow, PlanBadge, shortName, useNow } from '../../components/desk/ui';

const statLabels: Record<LimitWindowId, string> = { fiveHour: '5 hour', week: 'Week', fableWeek: 'Fable week' };

/** Core auth ids look like `claude-aaaa1111-name@x.com.json`; show the account instead. */
const authIdName = (id: string, labels: Map<string, string>) =>
  shortName(labels.get(id) ?? id.replace(/^claude-[0-9a-f]+-/, '').replace(/\.json$/, ''));

function Hero({ account, state, now }: { account: AccountLimits; state: RoutingState; now: number }) {
  const burn = projectBurn(state.history[account.name] ?? [], currentWindow(account.limits?.week, now), now);
  return (
    <section className="d-hero" aria-label="Current account">
      <div className="d-hero-who">
        <span className="d-t3">New sessions go to</span>
        <b>{shortName(account.label)}</b>
        <span className="d-t3">{account.label}</span>
      </div>
      {(['fiveHour', 'week', 'fableWeek'] as const).map((id) => {
        const window = currentWindow(account.limits?.[id], now);
        const pct = window?.usedPct ?? 0;
        return (
          <div key={id} className="d-stat">
            <div className="d-k">{statLabels[id]}</div>
            <div className="d-v d-num">{window ? `${Math.round(pct)}%` : 'n/a'}</div>
            <Meter pct={pct} />
            <div className="d-f">
              {window?.resetsAtMs
                ? `Resets ${clockText(window.resetsAtMs, now)} · ${leftText(window.resetsAtMs, now)} left`
                : window ? 'Reset time unknown' : 'No data yet'}
              {id === 'week' && burn.leftAtResetPct !== null && burn.leftAtResetPct >= 10
                ? <span className="d-warn"> · ~{burn.leftAtResetPct}% unused at this pace</span>
                : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function OrderTable({ state, now }: { state: RoutingState; now: number }) {
  const manual = state.settings.mode === 'manual';
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const byName = new Map(state.accounts.map((account) => [account.name, account]));
  const order = state.plan.map((entry) => entry.name);
  const serving = state.plan.find((entry) => entry.eligible)?.name;

  const move = (name: string, toIndex: number) => {
    const next = order.filter((item) => item !== name);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, name);
    updateRoutingSettings({ manualOrder: next });
  };

  const onDrop = (event: DragEvent, target: string) => {
    event.preventDefault();
    if (dragging && dragging !== target) move(dragging, order.indexOf(target));
    setDragging(null);
    setOver(null);
  };

  const onKeyDown = (event: KeyboardEvent, name: string) => {
    if (!manual || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    move(name, order.indexOf(name) + (event.key === 'ArrowUp' ? -1 : 1));
  };

  return (
    <div className={`d-table${manual ? ' d-manual' : ''}`} role="list" aria-label="Account order">
      <div className="d-tr d-head d-acct-row" aria-hidden="true">
        <span /><span className="d-rank">#</span><span>Account</span>
        <span className="d-c-5h">5 hour</span><span>Week</span><span className="d-c-fable">Fable week</span>
        <span className="d-right d-c-state">Status</span>
      </div>
      {state.plan.map((entry, index) => {
        const account = byName.get(entry.name);
        if (!account) return null;
        return (
          <div
            key={entry.name}
            role="listitem"
            tabIndex={manual ? 0 : -1}
            aria-label={manual ? `${account.label}, position ${index + 1}. Alt plus arrow keys to move.` : undefined}
            className={`d-tr d-acct-row${dragging === entry.name ? ' d-dragging' : ''}${over === entry.name && dragging !== entry.name ? ' d-over' : ''}`}
            draggable={manual}
            onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; setDragging(entry.name); }}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); setOver(entry.name); } }}
            onDragLeave={() => setOver((current) => (current === entry.name ? null : current))}
            onDrop={(event) => onDrop(event, entry.name)}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onKeyDown={(event) => onKeyDown(event, entry.name)}
          >
            <GripVertical className="d-icon d-handle" aria-hidden="true" />
            <span className="d-rank d-num">{index + 1}</span>
            <span className="d-who"><b>{shortName(account.label)}</b><span>{account.label}</span></span>
            <MiniWindow className="d-c-5h" window={account.limits?.fiveHour} now={now} label="5h" />
            <MiniWindow window={account.limits?.week} now={now} />
            <MiniWindow className="d-c-fable" window={account.limits?.fableWeek} now={now} />
            <span className="d-right d-c-state"><PlanBadge entry={entry} serving={entry.name === serving} now={now} /></span>
          </div>
        );
      })}
      {!state.plan.length ? <div className="d-empty">No Claude accounts yet.</div> : null}
    </div>
  );
}

type ActivityRow = { key: string; atMs: number; time: string; body: ReactNode; tail: string };

function activityRows(state: RoutingState, labels: Map<string, string>, now: number): ActivityRow[] {
  const warm = state.warmSessions.map((session): ActivityRow => {
    const atMs = Date.parse(session.lastSeen) || now;
    return {
      key: `w-${session.session}`,
      atMs,
      time: clockText(atMs, now),
      body: (
        <span>Warm on <b>{authIdName(session.account, labels)}</b>
          <span className="d-t3"> · cache holds {Math.ceil(session.warmSecondsLeft / 60)} more minutes</span>
        </span>
      ),
      tail: session.model,
    };
  });
  const moves = state.moves.map((move): ActivityRow => {
    const atMs = Date.parse(move.at) || 0;
    return {
      key: `m-${move.at}-${move.session}-${move.toAccount}`,
      atMs,
      time: clockText(atMs, now),
      body: (
        <span>
          Session moved {move.fromAccount ? <b>{authIdName(move.fromAccount, labels)}</b> : 'an account'} to <b>{authIdName(move.toAccount, labels)}</b>
          {move.reason ? <span className="d-reason" title={move.reason}>{move.reason}</span> : null}
        </span>
      ),
      tail: 'Cache rebuilt',
    };
  });
  return [...warm, ...moves].sort((a, b) => b.atMs - a.atMs).slice(0, 10);
}

export function OverviewView() {
  const state = useRoutingState();
  const { status } = useCoreRuntime();
  const { go } = useDeskNav();
  const now = useNow();
  const labels = useMemo(() => new Map(state.accounts.map((account) => [account.name, account.label])), [state.accounts]);
  const servingName = state.plan.find((entry) => entry.eligible)?.name ?? state.plan[0]?.name;
  const serving = state.accounts.find((account) => account.name === servingName);
  const activity = activityRows(state, labels, now);
  const { settings } = state;

  const setMode = (mode: 'automatic' | 'manual') => {
    if (mode === settings.mode) return;
    // Entering manual starts from the order currently in effect.
    updateRoutingSettings(mode === 'manual'
      ? { mode, manualOrder: settings.manualOrder.length ? settings.manualOrder : state.plan.map((entry) => entry.name) }
      : { mode });
  };

  return (
    <>
      <div className="d-ph">
        <h1>Overview</h1>
        <div className="d-r">
          <span className="d-t3 d-num">
            {state.lastRunMs ? `Updated ${clockText(state.lastRunMs, now)}` : status?.ready ? 'Loading' : ''}
          </span>
          <button type="button" className="d-btn" disabled={state.busy || !status?.ready} onClick={() => void runRoutingTick(true)}>
            <RefreshCw className="d-icon" aria-hidden="true" />Refresh
          </button>
        </div>
      </div>

      {status && !status.ready ? (
        <div className="d-notice d-warn">
          <span>The proxy core is not running, so limits and routing are paused.</span>
        </div>
      ) : null}
      {state.lastError ? <div className="d-notice d-bad">{state.lastError}</div> : null}
      {!settings.auto ? (
        <div className="d-notice">
          <span>Routing is paused. The order below is a preview and priorities are not written.</span>
          <button type="button" className="d-link" style={{ marginLeft: 'auto' }} onClick={() => updateRoutingSettings({ auto: true })}>Resume</button>
        </div>
      ) : null}
      {state.refills.map((refill) => (
        <div key={`${refill.name}-${refill.atMs}`} className="d-notice d-ok">
          <span><b>{authIdName(refill.name, labels)}</b> was refilled. Its week still resets {clockText(refill.resetsAtMs, now)}.</span>
        </div>
      ))}

      {serving ? <Hero account={serving} state={state} now={now} /> : null}

      <div className="d-title">
        <h2>Order</h2>
        <div className="d-r">
          <div className="d-seg" role="group" aria-label="Order mode">
            <button type="button" aria-pressed={settings.mode === 'automatic'} onClick={() => setMode('automatic')}>Automatic</button>
            <button type="button" aria-pressed={settings.mode === 'manual'} onClick={() => setMode('manual')}>Manual</button>
          </div>
        </div>
      </div>
      <OrderTable state={state} now={now} />
      <p className="d-note">
        {settings.mode === 'automatic'
          ? `Automatic: soonest weekly reset first. Skips accounts at ${settings.headroomPct}% of 5 hour or ${settings.weeklyCutoffPct}% of week. Sessions already on an account stay there.`
          : 'Manual: drag rows to set the order. Limited accounts are still skipped until they recover. Sessions already on an account stay there.'}
        {' '}
        <button type="button" className="d-link" onClick={() => go('settings', { settingsSection: 'routing' })}>Routing settings</button>
      </p>

      <div className="d-title">
        <h2>Activity</h2>
        <div className="d-r"><button type="button" className="d-link" onClick={() => go('usage')}>All usage</button></div>
      </div>
      <div className="d-table">
        {activity.map((row) => (
          <div key={row.key} className="d-tr d-act-row">
            <span className="d-t3 d-num">{row.time}</span>
            {row.body}
            <span className="d-t3">{row.tail}</span>
          </div>
        ))}
        {!activity.length ? <div className="d-empty">No sessions in the last hour.</div> : null}
      </div>
    </>
  );
}
