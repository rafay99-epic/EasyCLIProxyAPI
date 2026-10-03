// App-wide navigation for the CPA Desk shell. Pages, the command palette and the core
// menu all move through `go`, which can also target a sub-view (Settings section,
// Accounts tab) or open the sign-in sheet.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ConfigSubpage } from './pages/ConfigPanel';

export type DeskPage = 'overview' | 'accounts' | 'clients' | 'usage' | 'settings';
export type AccountsTab = 'accounts' | 'keys' | 'files' | 'quota';
export type SettingsSection = 'routing' | 'core' | 'versions' | ConfigSubpage;

export type DeskTarget = {
  accountsTab?: AccountsTab;
  settingsSection?: SettingsSection;
  /** Open the subscription sign-in sheet on the Accounts page. */
  signIn?: boolean;
};

type DeskNav = {
  page: DeskPage;
  target: DeskTarget;
  go: (page: DeskPage, target?: DeskTarget) => void;
  /** Bumped on every navigation so pages can replay their enter animation. */
  visit: number;
};

const DeskNavContext = createContext<DeskNav | null>(null);

export function DeskNavProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<DeskPage>('overview');
  const [target, setTarget] = useState<DeskTarget>({});
  const [visit, setVisit] = useState(0);
  const go = useCallback((next: DeskPage, nextTarget: DeskTarget = {}) => {
    setPage(next);
    setTarget(nextTarget);
    setVisit((value) => value + 1);
  }, []);
  const value = useMemo(() => ({ page, target, go, visit }), [page, target, go, visit]);
  return <DeskNavContext.Provider value={value}>{children}</DeskNavContext.Provider>;
}

export function useDeskNav(): DeskNav {
  const nav = useContext(DeskNavContext);
  if (!nav) throw new Error('useDeskNav must be used inside DeskNavProvider');
  return nav;
}
