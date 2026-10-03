// Clients: the connection details every tool needs, then the existing agent setup
// (Claude Code, Codex, OpenCode and the rest). Agent writes go to the CPA Desk sandbox
// home unless the user switches to real configs from the notice above them.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentConfigTargetNotice } from '../../components/AgentConfigTargetNotice';
import { AgentsPage } from '../AgentsPage';
import { clientApiProfiles } from '../../services/clientAccess';
import { maskSecret } from '../../services/managementApi';

type Connection = { base: string; openai: string; apiKey: string | null };

async function loadConnection(): Promise<Connection> {
  const [gui, core, tls] = await Promise.all([
    invoke<{ host: string; port: number }>('get_gui_settings'),
    invoke<{ apiKeys: { apiKey: string }[] }>('get_core_config_settings').catch(() => ({ apiKeys: [] })),
    invoke<{ enabled: boolean }>('get_core_tls_settings').catch(() => ({ enabled: false })),
  ]);
  const profiles = clientApiProfiles(gui.port, tls.enabled, gui.host);
  return {
    base: profiles.find((profile) => profile.id === 'claude')?.baseUrl ?? '',
    openai: profiles.find((profile) => profile.id === 'openai')?.baseUrl ?? '',
    apiKey: core.apiKeys[0]?.apiKey ?? null,
  };
}

function ConnField({ label, value, shown, copied, onCopy }: {
  label: string;
  value: string;
  shown: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="d-k">
        {label}
        <button type="button" className="d-link" disabled={!value} onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="d-v d-mono" title={shown}>{shown || 'Not set'}</div>
    </div>
  );
}

export function ClientsView() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [copied, setCopied] = useState('');
  // Switching sandbox/live changes every detected path, so the agent view reloads.
  const [target, setTarget] = useState(0);

  useEffect(() => {
    void loadConnection().then(setConnection).catch(() => setConnection(null));
  }, []);

  const copy = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      window.setTimeout(() => setCopied((current) => (current === field ? '' : current)), 1600);
    } catch {
      setCopied('');
    }
  };

  return (
    <>
      <div className="d-ph"><h1>Clients</h1></div>
      <div className="d-conn">
        <ConnField label="Base URL" value={connection?.base ?? ''} shown={connection?.base ?? ''} copied={copied === 'base'} onCopy={() => void copy('base', connection?.base ?? '')} />
        <ConnField label="OpenAI compatible" value={connection?.openai ?? ''} shown={connection?.openai ?? ''} copied={copied === 'openai'} onCopy={() => void copy('openai', connection?.openai ?? '')} />
        <ConnField
          label="API key"
          value={connection?.apiKey ?? ''}
          shown={connection?.apiKey ? maskSecret(connection.apiKey) : ''}
          copied={copied === 'key'}
          onCopy={() => void copy('key', connection?.apiKey ?? '')}
        />
      </div>
      <AgentConfigTargetNotice onChange={() => setTarget((value) => value + 1)} />
      <div className="d-embed d-embed-agents"><AgentsPage key={target} hideTitle /></div>
    </>
  );
}
