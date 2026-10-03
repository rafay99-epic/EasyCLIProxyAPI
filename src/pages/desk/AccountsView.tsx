// Accounts: every credential the core can route to. The first tab is the native list
// (limits, status, a details sheet with settings, models, disable and remove); the other
// tabs host the existing API key, file and quota managers unchanged.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, ChevronRight, FileUp, FolderOpen, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { AuthFileModelsDialog } from '../../components/AuthFileModelsDialog';
import { AuthFileSettingsDialog } from '../../components/AuthFileSettingsDialog';
import { ConfirmationDialog, type ConfirmationOptions } from '../../components/ConfirmationDialog';
import { Sheet } from '../../components/desk/Sheet';
import { clockText, MiniWindow, PlanBadge, ProviderMark, providerLabel, shortName, useNow } from '../../components/desk/ui';
import { useDeskNav, type AccountsTab } from '../../deskNav';
import { authFileName, dedupeAuthFiles, isOAuthCredentialFile, isRuntimeOnlyAuthFile, parseAuthFilePriority, setOAuthCredentialFileDisabled } from '../../services/authFiles';
import { currentWindow } from '../../services/limits';
import { managementApi, readBoolean, readNumber, readString, responseList } from '../../services/managementApi';
import { updateQuotaCache, useQuotaCache } from '../../services/quotaCache';
import { idleQuota, loadQuota, providerForFile, quotaKey, type AuthFile, type QuotaState } from '../../services/quotaService';
import { runRoutingTick, useRoutingState, type RoutingState } from '../../services/routingController';
import { ApiAccessPage } from '../ApiAccessPage';
import { AuthFileManagementPage } from '../AuthFileManagementPage';
import { OAuthLoginPage } from '../ManagementPages';
import { QuotaPage } from '../QuotaPage';

const tabs: { id: AccountsTab; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'keys', label: 'API keys' },
  { id: 'files', label: 'Files' },
  { id: 'quota', label: 'Quota' },
];

const providerOf = (file: AuthFile) => {
  const value = readString(file, 'provider', 'type', 'account_type').toLowerCase();
  if (value === 'anthropic') return 'claude';
  if (value === 'cognition') return 'devin';
  if (value === 'anti-gravity') return 'antigravity';
  if (value === 'x-ai' || value === 'grok') return 'xai';
  return value;
};

const emailOf = (file: AuthFile) => readString(file, 'email', 'account', 'label');

/** Non-Claude quota rows report remaining percent; the list shows used percent like Claude. */
function QuotaMini({ quota, index, className }: { quota: QuotaState | undefined; index: number; className: string }) {
  const row = quota?.status === 'success' ? quota.rows[index] : undefined;
  if (!row || row.remainingPercent === null) return <span className={`d-t3 ${className}`}>{quota?.status === 'loading' ? 'checking' : ''}</span>;
  return (
    <MiniWindow
      className={className}
      window={{ usedPct: 100 - row.remainingPercent, resetsAtMs: row.resetAtMs ?? null }}
      now={Date.now()}
      label={row.label}
    />
  );
}

function AccountRow({ file, routing, quota, now, onOpen }: {
  file: AuthFile;
  routing: RoutingState;
  quota: QuotaState | undefined;
  now: number;
  onOpen: () => void;
}) {
  const name = authFileName(file);
  const provider = providerOf(file);
  const email = emailOf(file);
  const limits = routing.accounts.find((account) => account.name === name)?.limits;
  const entry = routing.plan.find((planned) => planned.name === name);
  const serving = routing.plan.find((planned) => planned.eligible)?.name === name;
  const disabled = readBoolean(file, 'disabled');
  return (
    <div className="d-tr d-click d-acc-row" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}>
      <span className="d-who"><b>{email ? shortName(email) : name}</b><span>{email || name}</span></span>
      <span className="d-provider d-c-plan"><ProviderMark provider={provider} />{providerLabel(provider)}</span>
      {provider === 'claude' ? (
        <>
          <MiniWindow className="d-c-5h" window={limits?.fiveHour} now={now} label="5h" />
          <MiniWindow className="d-c-week" window={limits?.week} now={now} label={limits?.week?.resetsAtMs ? clockText(currentWindow(limits.week, now)?.resetsAtMs ?? null, now) : 'week'} />
        </>
      ) : (
        <>
          <QuotaMini quota={quota} index={0} className="d-c-5h" />
          <QuotaMini quota={quota} index={1} className="d-c-week" />
        </>
      )}
      <span className="d-right">
        {disabled
          ? <span className="d-badge">Disabled</span>
          : provider === 'claude' && entry
            ? <PlanBadge entry={entry} serving={serving} now={now} />
            : isRuntimeOnlyAuthFile(file)
              ? <span className="d-badge">Runtime</span>
              : <span className="d-badge d-ok">Active</span>}
      </span>
      <ChevronRight className="d-chev" aria-hidden="true" />
    </div>
  );
}

function AccountSheet({ file, routing, quota, now, onClose, onChanged, onRefreshQuota }: {
  file: AuthFile;
  routing: RoutingState;
  quota: QuotaState | undefined;
  now: number;
  onClose: () => void;
  onChanged: () => void;
  onRefreshQuota: () => void;
}) {
  const name = authFileName(file);
  const provider = providerOf(file);
  const email = emailOf(file);
  const disabled = readBoolean(file, 'disabled');
  const editable = isOAuthCredentialFile(file);
  const account = routing.accounts.find((item) => item.name === name);
  const entry = routing.plan.find((item) => item.name === name);
  const [dialog, setDialog] = useState<'settings' | 'models' | null>(null);
  const [confirm, setConfirm] = useState<(ConfirmationOptions & { run: () => Promise<void> }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  };

  const windows = provider === 'claude'
    ? (['fiveHour', 'week', 'fableWeek'] as const).map((id) => {
        const window = currentWindow(account?.limits?.[id], now);
        const label = { fiveHour: '5 hour', week: 'Week', fableWeek: 'Fable week' }[id];
        return [label, window ? `${Math.round(window.usedPct)}% used · resets ${clockText(window.resetsAtMs, now)}` : 'No data yet'] as const;
      })
    : (quota?.status === 'success' ? quota.rows : []).map((row) =>
        [row.label, row.remainingPercent === null ? 'Unknown' : `${Math.round(100 - row.remainingPercent)}% used${row.resetAtMs ? ` · resets ${clockText(row.resetAtMs, now)}` : ''}`] as const);
  const success = readNumber(file, 'success');
  const failed = readNumber(file, 'failed');
  const priority = parseAuthFilePriority(file.priority) ?? 0;

  return (
    <>
      <Sheet
        title={email ? shortName(email) : name}
        subtitle={email || providerLabel(provider)}
        onClose={onClose}
        footer={(
          <>
            {editable ? (
              <button type="button" className="d-btn" disabled={busy} onClick={() => void act(() => setOAuthCredentialFileDisabled(file, !disabled))}>
                {disabled ? 'Enable' : 'Disable'}
              </button>
            ) : null}
            <button type="button" className="d-btn d-danger" disabled={busy || isRuntimeOnlyAuthFile(file)} onClick={() => setConfirm({
              title: 'Remove account',
              message: `Delete ${name} from CPA Desk? Sessions on this account move to another one and rebuild their cache.`,
              confirmText: 'Remove',
              variant: 'danger',
              run: async () => {
                await managementApi.delete('/auth-files', { query: { name } });
                onClose();
              },
            })}>Remove</button>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="d-btn" onClick={() => setDialog('models')}>Models</button>
              {editable ? <button type="button" className="d-btn d-primary" onClick={() => setDialog('settings')}>Settings</button> : null}
            </span>
          </>
        )}
      >
        {error ? <div className="d-notice d-bad">{error}</div> : null}
        <div className="d-title" style={{ marginTop: 0 }}>
          <h2>Limits</h2>
          {provider !== 'claude' && providerForFile(file) ? (
            <div className="d-r">
              <button type="button" className="d-link" disabled={quota?.status === 'loading' || disabled} onClick={onRefreshQuota}>
                {quota?.status === 'loading' ? 'Checking' : 'Check now'}
              </button>
            </div>
          ) : null}
        </div>
        <dl className="d-kv">
          {windows.length
            ? windows.map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd className="d-num">{value}</dd></div>)
            : <><dt>Quota</dt><dd className="d-t3">{quota?.status === 'error' ? quota.error ?? 'Check failed' : providerForFile(file) ? 'Not checked yet' : 'Not reported by this provider'}</dd></>}
          {quota?.plan ? <><dt>Plan</dt><dd>{quota.plan}</dd></> : null}
        </dl>

        <div className="d-title"><h2>Routing</h2></div>
        <dl className="d-kv">
          <dt>Status</dt><dd>{entry ? <PlanBadge entry={entry} serving={routing.plan.find((item) => item.eligible)?.name === name} now={now} /> : disabled ? 'Disabled' : 'Active'}</dd>
          {entry ? <><dt>Why</dt><dd className="d-t2">{entry.reason}</dd></> : null}
          <dt>Priority</dt>
          <dd className="d-num">{priority}{provider === 'claude' && routing.settings.auto ? <span className="d-t3"> · set by routing</span> : null}</dd>
        </dl>

        <div className="d-title"><h2>Details</h2></div>
        <dl className="d-kv">
          <dt>Provider</dt><dd>{providerLabel(provider)}</dd>
          <dt>File</dt><dd className="d-mono">{name}</dd>
          {success !== null || failed !== null
            ? <><dt>Requests</dt><dd className="d-num">{success ?? 0} ok · {failed ?? 0} failed</dd></>
            : null}
          {readString(file, 'status_message') ? <><dt>Last error</dt><dd className="d-t2">{readString(file, 'status_message')}</dd></> : null}
        </dl>
      </Sheet>

      {dialog === 'settings' ? <AuthFileSettingsDialog key={name} name={name} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged(); }} /> : null}
      {dialog === 'models' ? <AuthFileModelsDialog name={name} onClose={() => setDialog(null)} /> : null}
      {confirm ? (
        <ConfirmationDialog
          {...confirm}
          onDecision={(confirmed) => {
            const { run } = confirm;
            setConfirm(null);
            if (confirmed) void act(run);
          }}
        />
      ) : null}
    </>
  );
}

function AccountsList({ files, loading, error, reload }: { files: AuthFile[]; loading: boolean; error: string; reload: () => void }) {
  const routing = useRoutingState();
  const quotas = useQuotaCache();
  const now = useNow();
  const [openName, setOpenName] = useState<string | null>(null);

  const refreshQuota = useCallback(async (file: AuthFile) => {
    const key = quotaKey(file);
    updateQuotaCache((current) => ({ ...current, [key]: { status: 'loading', rows: [] } }));
    const result = await loadQuota(file);
    updateQuotaCache((current) => ({ ...current, [key]: result }));
  }, []);

  // Claude limits come from the routing controller; other providers are checked once per visit.
  useEffect(() => {
    for (const file of files) {
      if (providerOf(file) === 'claude' || !providerForFile(file) || readBoolean(file, 'disabled')) continue;
      if ((quotas[quotaKey(file)] ?? idleQuota()).status === 'idle') void refreshQuota(file);
    }
    // Only when the file list changes, not on every quota update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, refreshQuota]);

  const sorted = [...files].sort((left, right) => {
    const rank = (file: AuthFile) => {
      const index = routing.plan.findIndex((entry) => entry.name === authFileName(file));
      return readBoolean(file, 'disabled') ? 10_000 : index >= 0 ? index : 1_000;
    };
    return rank(left) - rank(right) || providerOf(left).localeCompare(providerOf(right)) || authFileName(left).localeCompare(authFileName(right));
  });
  const open = files.find((file) => authFileName(file) === openName);

  return (
    <>
      {error ? <div className="d-notice d-bad">{error}</div> : null}
      <div className="d-table">
        <div className="d-tr d-head d-acc-row" aria-hidden="true">
          <span>Account</span><span className="d-c-plan">Provider</span><span className="d-c-5h">5 hour</span>
          <span className="d-c-week">Week</span><span className="d-right">Status</span><span />
        </div>
        {sorted.map((file) => (
          <AccountRow
            key={authFileName(file)}
            file={file}
            routing={routing}
            quota={quotas[quotaKey(file)]}
            now={now}
            onOpen={() => setOpenName(authFileName(file))}
          />
        ))}
        {!files.length ? <div className="d-empty">{loading ? 'Loading accounts' : 'No accounts yet. Use Add to sign in.'}</div> : null}
      </div>
      {open ? (
        <AccountSheet
          file={open}
          routing={routing}
          quota={quotas[quotaKey(open)]}
          now={now}
          onClose={() => setOpenName(null)}
          onChanged={() => { reload(); void runRoutingTick(); }}
          onRefreshQuota={() => void refreshQuota(open)}
        />
      ) : null}
    </>
  );
}

export function AccountsView() {
  const { target, visit, go } = useDeskNav();
  const [tab, setTab] = useState<AccountsTab>(target.accountsTab ?? 'accounts');
  const [signIn, setSignIn] = useState(Boolean(target.signIn));
  const [menu, setMenu] = useState(false);
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);

  // Navigation can target a tab or open sign-in (command palette, Overview links).
  useEffect(() => {
    if (target.accountsTab) setTab(target.accountsTab);
    if (target.signIn) setSignIn(true);
  }, [target, visit]);

  const reload = useCallback(async () => {
    try {
      const payload = await managementApi.get('/auth-files');
      setFiles(dedupeAuthFiles(responseList(payload, 'files')));
      setError('');
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, tab]);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    try {
      for (const file of picked) await managementApi.uploadAuthFile(file);
      await reload();
      void runRoutingTick(true);
    } catch (uploadError) {
      setError(String(uploadError));
    }
  };

  const closeMenu = () => setMenu(false);
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  return (
    <>
      <div className="d-ph">
        <h1>Accounts</h1>
        <div className="d-r" style={{ position: 'relative' }}>
          <button type="button" className="d-btn" onClick={() => void reload()} aria-label="Reload accounts">
            <RefreshCw className="d-icon" aria-hidden="true" />
          </button>
          <button type="button" className="d-btn" onClick={() => void managementApi.openAuthFilesDirectory()}>
            <FolderOpen className="d-icon" aria-hidden="true" />Open folder
          </button>
          <button type="button" className="d-btn d-primary" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
            <Plus className="d-icon" aria-hidden="true" />Add<ChevronDown className="d-icon" aria-hidden="true" />
          </button>
          {menu ? (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 24 }} onClick={closeMenu} />
              <div className="d-pop" role="menu" style={{ top: 34, right: 0 }}>
                <div className="d-lbl">Subscriptions</div>
                <button type="button" role="menuitem" onClick={() => { closeMenu(); setSignIn(true); }}>
                  <ProviderMark provider="claude" />Sign in with Claude, Codex and more
                </button>
                <div className="d-sep" />
                <button type="button" role="menuitem" onClick={() => { closeMenu(); setTab('keys'); }}>
                  <KeyRound className="d-icon" aria-hidden="true" />Provider API key
                </button>
                <button type="button" role="menuitem" onClick={() => { closeMenu(); uploadRef.current?.click(); }}>
                  <FileUp className="d-icon" aria-hidden="true" />Import credential file
                </button>
              </div>
            </>
          ) : null}
          <input ref={uploadRef} type="file" accept=".json,application/json" multiple hidden onChange={(event) => void importFiles(event)} />
        </div>
      </div>

      <div className="d-tabs" role="tablist" aria-label="Accounts views">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
            {item.id === 'accounts' && files.length ? <span className="d-t3 d-num"> {files.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'accounts' ? <AccountsList files={files} loading={loading} error={error} reload={() => void reload()} /> : null}
      {tab === 'keys' ? <div className="d-embed"><ApiAccessPage /></div> : null}
      {tab === 'files' ? <div className="d-embed"><AuthFileManagementPage /></div> : null}
      {tab === 'quota' ? <div className="d-embed"><QuotaPage /></div> : null}

      {signIn ? (
        <Sheet
          wide
          title="Sign in"
          subtitle="Add a subscription account. It joins routing as soon as the sign-in finishes."
          onClose={() => { setSignIn(false); void reload(); void runRoutingTick(true); if (target.signIn) go('accounts'); }}
        >
          <div className="d-embed"><OAuthLoginPage /></div>
        </Sheet>
      ) : null}
    </>
  );
}
