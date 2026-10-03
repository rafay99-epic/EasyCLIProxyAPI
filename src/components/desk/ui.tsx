// Small building blocks shared by the CPA Desk pages: limit meters, time formatting,
// status badges for routing plan entries, and provider marks.

import { useEffect, useState, type CSSProperties } from 'react';
import { currentWindow, type LimitWindow, type PlannedAccount } from '../../services/limits';

/** Re-renders every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const shortName = (label: string) => label.split('@')[0] || label;

/** `21:49` today, `Fri 17:59` otherwise. */
export function clockText(ms: number | null, now: number) {
  if (ms === null) return 'unknown';
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** `6d 2h`, `3h 05m`, `12m`. */
export function leftText(ms: number | null, now: number) {
  if (ms === null) return '';
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

export const level = (pct: number) => (pct >= 90 ? 'd-bad' : pct >= 70 ? 'd-warn' : '');

export function Meter({ pct }: { pct: number }) {
  const value = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <span className="d-meter" aria-hidden="true">
      <i className={level(pct)} style={{ '--v': value } as CSSProperties} />
    </span>
  );
}

/** Compact percent + meter used in table cells. `label` defaults to the reset time. */
export function MiniWindow({ window, now, label, className = '' }: {
  window: LimitWindow | undefined;
  now: number;
  label?: string;
  className?: string;
}) {
  const current = currentWindow(window, now);
  if (!current) return <span className={`d-t3 ${className}`}>no data</span>;
  return (
    <span className={`d-mini ${className}`}>
      <span className="d-top">
        <span>{label ?? clockText(current.resetsAtMs, now)}</span>
        <b className={`d-num ${level(current.usedPct)}`}>{Math.round(current.usedPct)}%</b>
      </span>
      <Meter pct={current.usedPct} />
    </span>
  );
}

/** Status badge for an account's place in the routing plan. */
export function PlanBadge({ entry, serving, now }: { entry: PlannedAccount | undefined; serving: boolean; now: number }) {
  if (!entry) return <span className="d-badge">Unknown</span>;
  const back = entry.backAtMs !== null ? clockText(entry.backAtMs, now) : '';
  switch (entry.status) {
    case 'ready':
    case 'unknown':
      return serving ? <span className="d-badge d-ok">Serving</span> : <span className="d-badge">Ready</span>;
    case 'near-5h':
    case 'cooling':
      return <span className="d-badge d-warn" title={entry.reason}>{back ? `Back ${back}` : 'Paused'}</span>;
    case 'near-week':
      return <span className="d-badge d-warn" title={entry.reason}>Week nearly used</span>;
    case 'capped':
      return <span className="d-badge d-bad" title={entry.reason}>{back ? `Week used · ${back}` : 'Week used'}</span>;
    case 'disabled':
      return <span className="d-badge">Disabled</span>;
  }
}

const providerColors: Record<string, [string, string]> = {
  claude: ['#d97757', 'C'],
  codex: ['#ffffff', 'O'],
  antigravity: ['#7aa2ff', 'A'],
  gemini: ['#7aa2ff', 'G'],
  kimi: ['#bbbbbb', 'K'],
  xai: ['#dddddd', 'X'],
  devin: ['#9be7c4', 'D'],
  qwen: ['#a78bfa', 'Q'],
  iflow: ['#93c5fd', 'I'],
};

export function ProviderMark({ provider }: { provider: string }) {
  const [color, letter] = providerColors[provider] ?? ['#8c8c8c', (provider[0] ?? '?').toUpperCase()];
  return <span className="d-pmark" style={{ background: color }} aria-hidden="true">{letter}</span>;
}

export const providerLabel = (provider: string) =>
  ({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini', kimi: 'Kimi', xai: 'xAI', devin: 'Devin', qwen: 'Qwen', iflow: 'iFlow' })[provider]
  ?? (provider ? provider[0].toUpperCase() + provider.slice(1) : 'Unknown');
