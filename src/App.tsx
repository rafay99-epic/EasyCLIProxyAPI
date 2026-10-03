// CPA Desk shell: collapsible sidebar (auto rail under 1080px, ⌘\ toggles), ⌘K command
// palette, core status menu, and five pages. The routing controller is mounted here so
// account priorities stay current while the window is hidden.

import { MessageNotice } from './appNotice';
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { BarChart3, Gauge, PanelLeft, Plug, Search, Settings, Users, X } from 'lucide-react';
import { CoreRuntimeProvider, useCoreRuntime, type CoreStatus } from './coreRuntime';
import { CoreUpdateProvider } from './coreUpdate';
import { AppUpdateDialog, AppUpdateProvider } from './appUpdate';
import { canOpenAppPage } from './navigation';
import { DeskNavProvider, useDeskNav, type DeskPage, type SettingsSection } from './deskNav';
import { useDialogFocusTrap } from './components/useDialogFocusTrap';
import { CommandPalette, type Command } from './components/desk/CommandPalette';
import { MenubarBridge } from './components/desk/MenubarBridge';
import { useBuildChannel } from './services/deskSnapshot';
import { useDeskUpdate } from './services/deskUpdate';
import { shortName } from './components/desk/ui';
import { runRoutingTick, useRoutingController, useRoutingState } from './services/routingController';
import { useI18n } from './i18n';
import { OverviewView } from './pages/desk/OverviewView';
import { AccountsView } from './pages/desk/AccountsView';
import { ClientsView } from './pages/desk/ClientsView';
import { SettingsView } from './pages/desk/SettingsView';
import { UsageRecordsPage } from './pages/UsageRecordsPage';

type PageDef = { id: DeskPage; label: string; icon: ComponentType<{ className?: string }>; view: ComponentType; wide?: boolean };

function UsageView() {
  return <div className="d-embed d-embed-usage"><UsageRecordsPage /></div>;
}

const pages: PageDef[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, view: OverviewView },
  { id: 'accounts', label: 'Accounts', icon: Users, view: AccountsView },
  { id: 'clients', label: 'Clients', icon: Plug, view: ClientsView, wide: true },
  { id: 'usage', label: 'Usage', icon: BarChart3, view: UsageView, wide: true },
  { id: 'settings', label: 'Settings', icon: Settings, view: SettingsView },
];

const settingsCommands: { id: SettingsSection; label: string }[] = [
  { id: 'routing', label: 'Routing' },
  { id: 'network', label: 'Network' },
  { id: 'general', label: 'Access keys' },
  { id: 'aliases', label: 'Model aliases' },
  { id: 'sensitive-words', label: 'Prompt filters' },
  { id: 'software', label: 'General' },
  { id: 'core', label: 'Core' },
  { id: 'versions', label: 'Versions' },
];

type CoreCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';
type WindowsCloseAction = 'exit' | 'minimize-to-tray';
type WindowsClosePrompt = { resolvingAction: WindowsCloseAction | null; rememberChoice: boolean; error: string | null };

const SIDEBAR_KEY = 'cpa-desk.sidebar-rail';
const RAIL_BELOW_PX = 1080;

function App() {
  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <DeskNavProvider>
            <AppContent />
          </DeskNavProvider>
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

/** Rail when the user chose it, else automatically on narrow windows. */
function useSidebarRail() {
  const [preference, setPreference] = useState<boolean | null>(() => {
    const stored = window.localStorage.getItem(SIDEBAR_KEY);
    return stored === null ? null : stored === 'true';
  });
  const [narrow, setNarrow] = useState(() => window.innerWidth < RAIL_BELOW_PX);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${RAIL_BELOW_PX - 1}px)`);
    const update = () => {
      setNarrow(query.matches);
      // Crossing the breakpoint hands control back to the automatic behaviour.
      setPreference(null);
      window.localStorage.removeItem(SIDEBAR_KEY);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const rail = preference ?? narrow;
  const toggle = useCallback(() => {
    const next = !rail;
    setPreference(next);
    window.localStorage.setItem(SIDEBAR_KEY, String(next));
  }, [rail]);
  return [rail, toggle] as const;
}

function useCoreControl() {
  const { status, publishStatus, refreshStatus } = useCoreRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (command: CoreCommand) => {
    setBusy(true);
    setError('');
    try {
      publishStatus(await invoke<CoreStatus>(command));
    } catch (commandError) {
      setError(String(commandError));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [publishStatus, refreshStatus]);
  return { status, busy: busy || Boolean(status?.starting), error, clearError: () => setError(''), run };
}

function CoreMenu({ rail, control, onGo }: {
  rail: boolean;
  control: ReturnType<typeof useCoreControl>;
  onGo: (section: SettingsSection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const { status, busy, run } = control;
  const { ready: updateReady } = useDeskUpdate();

  useEffect(() => {
    void invoke<{ port: number }>('get_gui_settings').then((settings) => setPort(settings.port)).catch(() => setPort(null));
  }, [status?.running]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const tone = status?.ready ? 'd-ok' : status?.starting || (status?.running && !status.ready) ? 'd-warn' : status ? '' : 'd-bad';
  const label = !status
    ? 'Core unknown'
    : status.starting ? 'Core starting'
      : status.ready ? `Core running${port ? ` · ${port}` : ''}`
        : status.running ? 'Core not ready'
          : status.installed ? 'Core stopped' : 'Core not installed';
  const act = (action: () => void) => { setOpen(false); action(); };

  return (
    <div className="d-side-foot">
      <button type="button" className="d-core-btn" aria-haspopup="menu" aria-expanded={open} title={rail ? label : undefined}
        onClick={() => setOpen((value) => !value)}>
        <span className={`d-dot ${tone}`} />
        <span className="d-label">{label}</span>
        {updateReady ? <span className="d-label d-ok" style={{ marginLeft: 'auto' }}>Update</span> : null}
      </button>
      {open ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 24 }} onClick={() => setOpen(false)} />
          <div className="d-pop" role="menu" style={{ bottom: 40, left: 0, transformOrigin: 'bottom left' }}>
            <div className="d-lbl">
              {status?.currentVersion ? `Core ${status.currentVersion}` : 'Core'}
              {status?.processId ? ` · PID ${status.processId}` : ''}
            </div>
            {status?.running ? (
              <>
                <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => void run('restart_core_process'))}>Restart core</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => void run('stop_core_process'))}>Stop core</button>
              </>
            ) : (
              <button type="button" role="menuitem" disabled={busy || !status?.installed} onClick={() => act(() => void run('start_core_process'))}>Start core</button>
            )}
            <div className="d-sep" />
            <button type="button" role="menuitem" onClick={() => act(() => onGo('versions'))}>
              Versions and updates{updateReady ? <span className="d-ok" style={{ marginLeft: 'auto' }}>Ready</span> : null}
            </button>
            <button type="button" role="menuitem" onClick={() => act(() => onGo('core'))}>Core settings</button>
            <button type="button" role="menuitem" onClick={() => act(() => void invoke('open_core_logs_directory').catch(() => undefined))}>Open logs folder</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CoreRequired({ control }: { control: ReturnType<typeof useCoreControl> }) {
  const { status, busy, run } = control;
  return (
    <>
      <div className="d-ph"><h1>Accounts</h1></div>
      <div className="d-notice d-warn">
        <span>{status?.installed ? 'Start the proxy core to manage accounts.' : 'Install the proxy core from Settings, Versions.'}</span>
        {status?.installed ? (
          <button type="button" className="d-btn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void run('start_core_process')}>
            {busy ? 'Starting' : 'Start core'}
          </button>
        ) : null}
      </div>
    </>
  );
}

function AppContent() {
  const { t } = useI18n();
  const { page, go, visit } = useDeskNav();
  const control = useCoreControl();
  const coreReady = Boolean(control.status?.ready);
  const routing = useRoutingState();
  const [rail, toggleRail] = useSidebarRail();
  const [palette, setPalette] = useState(false);
  const [closePrompt, setClosePrompt] = useState<WindowsClosePrompt | null>(null);
  const channel = useBuildChannel();
  const deskUpdate = useDeskUpdate();
  useRoutingController(coreReady);

  const current = pages.find((item) => item.id === page) ?? pages[0];
  const View = current.view;

  // Global shortcuts: ⌘K palette, ⌘\ sidebar, ⌘1-5 pages.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((value) => !value);
      } else if (event.key === '\\') {
        event.preventDefault();
        toggleRail();
      } else if (/^[1-5]$/.test(event.key)) {
        const target = pages[Number(event.key) - 1];
        if (target && canOpenAppPage(target.id, coreReady)) {
          event.preventDefault();
          go(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [coreReady, go, toggleRail]);

  const commands = useMemo<Command[]>(() => [
    ...pages.map((item, index) => ({ id: `page-${item.id}`, label: item.label, hint: `⌘${index + 1}`, run: () => go(item.id) })),
    ...settingsCommands.map((item) => ({
      id: `settings-${item.id}`, label: `Settings: ${item.label}`, run: () => go('settings', { settingsSection: item.id }),
    })),
    ...routing.accounts.map((account) => ({
      id: `account-${account.name}`, label: shortName(account.label), hint: account.label, run: () => go('accounts'),
    })),
    { id: 'sign-in', label: 'Add account', hint: 'Sign in', run: () => go('accounts', { signIn: true }) },
    { id: 'api-keys', label: 'API keys', run: () => go('accounts', { accountsTab: 'keys' }) },
    ...(channel === 'dev' ? [] : [{ id: 'import', label: 'Import from EasyCLIProxyAPI', run: () => go('overview', { migrate: true }) }]),
    { id: 'refresh', label: 'Refresh limits', run: () => void runRoutingTick(true) },
    { id: 'check-update', label: 'Check for updates', run: () => { go('settings', { settingsSection: 'versions' }); void deskUpdate.check(); } },
    ...(deskUpdate.ready ? [{ id: 'install-update', label: `Restart to update to ${deskUpdate.status?.version ?? 'the new version'}`, run: () => void deskUpdate.install() }] : []),
    { id: 'sidebar', label: 'Toggle sidebar', hint: '⌘\\', run: toggleRail },
    control.status?.running
      ? { id: 'restart', label: 'Restart core', run: () => void control.run('restart_core_process') }
      : { id: 'start', label: 'Start core', run: () => void control.run('start_core_process') },
  ].filter((command) => !command.id.startsWith('page-accounts') || coreReady), [channel, control, coreReady, deskUpdate, go, routing.accounts, toggleRail]);

  // Windows only: the native close button asks whether to quit or hide to the tray.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen('windows-close-requested', async () => {
      try {
        const settings = await invoke<{ closeBehavior: 'ask' | WindowsCloseAction }>('get_gui_settings');
        if (settings.closeBehavior !== 'ask') {
          await invoke('resolve_windows_close_request', { action: settings.closeBehavior, remember: false });
          return;
        }
      } catch (error) {
        console.error('Failed to read close behavior settings', error);
      }
      setClosePrompt((value) => value ?? { resolvingAction: null, rememberChoice: false, error: null });
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, []);

  const resolveClose = async (action: WindowsCloseAction) => {
    setClosePrompt((value) => (value ? { ...value, resolvingAction: action, error: null } : value));
    try {
      await invoke('resolve_windows_close_request', { action, remember: closePrompt?.rememberChoice ?? false });
      setClosePrompt(null);
    } catch (error) {
      setClosePrompt((value) => ({ resolvingAction: null, rememberChoice: value?.rememberChoice ?? false, error: String(error) }));
    }
  };
  const closeDialogRef = useDialogFocusTrap<HTMLElement>({
    active: Boolean(closePrompt),
    onEscape: closePrompt?.resolvingAction ? undefined : () => setClosePrompt(null),
    preventEscape: Boolean(closePrompt?.resolvingAction),
  });

  return (
    <div className="d-root">
      {/* The window uses an overlay title bar: this strip is where it can be dragged. */}
      <div className="d-titlebar" data-tauri-drag-region />
      <MenubarBridge onCoreCommand={(command) => void control.run(command)} />
      <div className={`d-app${rail ? ' d-rail' : ''}`}>
        <aside className="d-side" aria-label="Sidebar">
          <div className="d-side-top">
            <b>{channel === 'dev' ? 'CPA Desk Dev' : 'CPA Desk'}</b>
            <button type="button" className="d-iconbtn" aria-label="Toggle sidebar" title="Toggle sidebar  ⌘\" onClick={toggleRail}>
              <PanelLeft className="d-icon" aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="d-search" onClick={() => setPalette(true)} title={rail ? 'Search  ⌘K' : undefined}>
            <Search className="d-icon" aria-hidden="true" /><span>Search</span><kbd className="d-kbd">⌘K</kbd>
          </button>
          <nav className="d-nav" aria-label="Main">
            {pages.map((item) => {
              const Icon = item.icon;
              const locked = !canOpenAppPage(item.id, coreReady);
              return (
                <button
                  key={item.id}
                  type="button"
                  data-label={item.label}
                  aria-current={item.id === page ? 'page' : undefined}
                  title={locked ? 'Start the core to open this page' : undefined}
                  onClick={() => go(item.id)}
                >
                  <Icon className="d-icon" aria-hidden="true" />
                  <span className="d-label">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <CoreMenu rail={rail} control={control} onGo={(section) => go('settings', { settingsSection: section })} />
        </aside>

        <main className="d-main">
          <div className={`d-page${current.wide ? ' d-wide' : ''}`}>
            {control.error ? <MessageNotice message={control.error} onDismiss={control.clearError} /> : null}
            <div className="d-enter" key={`${page}-${visit}`}>
              {canOpenAppPage(current.id, coreReady) ? <View /> : <CoreRequired control={control} />}
            </div>
          </div>
        </main>
      </div>

      {palette ? <CommandPalette commands={commands} onClose={() => setPalette(false)} /> : null}

      {closePrompt ? (
        <div className="close-dialog-backdrop">
          <section ref={closeDialogRef} className="close-dialog" role="alertdialog" tabIndex={-1} aria-modal="true"
            aria-labelledby="close-dialog-title" aria-describedby="close-dialog-description">
            <button type="button" className="close-dialog-dismiss" aria-label={t('common.cancel')} disabled={closePrompt.resolvingAction !== null}
              onClick={() => setClosePrompt(null)}>
              <X size={17} aria-hidden="true" />
            </button>
            <div className="close-dialog-heading"><h2 id="close-dialog-title">{t('app.close.title')}</h2></div>
            <p id="close-dialog-description">{t('app.close.description')}</p>
            {closePrompt.error ? <MessageNotice message={closePrompt.error} onDismiss={() => setClosePrompt((value) => (value ? { ...value, error: null } : value))} /> : null}
            <label className="close-dialog-remember">
              <input type="checkbox" checked={closePrompt.rememberChoice} disabled={closePrompt.resolvingAction !== null}
                onChange={(event) => {
                  const rememberChoice = event.currentTarget.checked;
                  setClosePrompt((value) => (value ? { ...value, rememberChoice } : value));
                }} />
              <span>{t('app.close.remember')}</span>
            </label>
            <div className="close-dialog-actions">
              <button type="button" className="close-choice-button primary-button" disabled={closePrompt.resolvingAction !== null}
                onClick={() => void resolveClose('minimize-to-tray')}>
                {closePrompt.resolvingAction === 'minimize-to-tray' ? t('app.close.minimizing') : t('app.close.minimize')}
              </button>
              <button type="button" className="close-choice-button danger-button" disabled={closePrompt.resolvingAction !== null}
                onClick={() => void resolveClose('exit')}>
                {closePrompt.resolvingAction === 'exit' ? t('app.close.exiting') : t('app.close.exit')}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <AppUpdateDialog />
    </div>
  );
}

export default App;
