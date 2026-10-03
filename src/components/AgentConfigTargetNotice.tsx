// One-line status at the top of Clients: where agent configs are written, plus the switch
// between the sandbox and the real home directory. Sandbox is the default so this build
// can't rewrite the ~/.claude or ~/.codex configs production depends on.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type AgentConfigTarget = { live: boolean; sandboxDir: string; locked?: boolean };

export function AgentConfigTargetNotice({ onChange }: { onChange: () => void }) {
  const [target, setTarget] = useState<AgentConfigTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    invoke<AgentConfigTarget>('get_agent_config_target').then(setTarget).catch(() => setTarget(null));
  }, []);

  if (!target) return null;

  const switchTo = async (live: boolean) => {
    try {
      setTarget(await invoke<AgentConfigTarget>('set_agent_config_live', { live }));
      setConfirming(false);
      setError('');
      onChange();
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <div className={`d-notice${target.live ? ' d-warn' : ''}`} role="status">
      <span className={`d-badge ${target.live ? 'd-warn' : 'd-ok'}`}>{target.live ? 'Live' : 'Sandbox'}</span>
      <span className="d-t2" title={target.live ? undefined : target.sandboxDir}>
        {target.live
          ? 'Writes your real ~/.claude, ~/.codex and other client configs.'
          : 'Writes to CPA Desk only. Your real ~/.claude and ~/.codex are untouched.'}
      </span>
      <span style={{ display: 'flex', gap: 12, marginLeft: 'auto' }}>
        {target.locked ? (
          <span className="d-t3">Always on in CPA Desk Dev</span>
        ) : target.live ? (
          <button type="button" className="d-link" onClick={() => void switchTo(false)}>Back to sandbox</button>
        ) : confirming ? (
          <>
            <button type="button" className="d-link d-bad" onClick={() => void switchTo(true)}>Confirm, write real configs</button>
            <button type="button" className="d-link" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="d-link" onClick={() => setConfirming(true)}>Use real configs</button>
        )}
      </span>
      {error ? <span className="d-bad" style={{ flexBasis: '100%' }}>{error}</span> : null}
    </div>
  );
}
