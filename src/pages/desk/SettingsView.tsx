// Settings: one left-hand section list. Routing leads with the CPA Desk controller's
// own options; every other section hosts the existing settings panel for that area.

import { useEffect, useState } from 'react';
import { useDeskNav, type SettingsSection } from '../../deskNav';
import { updateRoutingSettings, useRoutingState } from '../../services/routingController';
import { ConfigPanelPage } from '../ConfigPanel';
import { KernelPage } from '../Kernel';
import { VersionManagementPage } from '../VersionManagementPage';

const groups: { label: string; items: { id: SettingsSection; label: string }[] }[] = [
  { label: 'Proxy', items: [
    { id: 'routing', label: 'Routing' },
    { id: 'network', label: 'Network' },
    { id: 'general', label: 'Access keys' },
  ] },
  { label: 'Models', items: [
    { id: 'aliases', label: 'Model aliases' },
    { id: 'sensitive-words', label: 'Prompt filters' },
  ] },
  { label: 'App', items: [
    { id: 'software', label: 'General' },
    { id: 'core', label: 'Core' },
    { id: 'versions', label: 'Versions' },
  ] },
];

const sectionLabel = (id: SettingsSection) =>
  groups.flatMap((group) => group.items).find((item) => item.id === id)?.label ?? '';

function RoutingRows() {
  const { settings } = useRoutingState();
  return (
    <>
      <div className="d-srow">
        <span className="d-k"><b>Reset-first routing</b><span>Keep account priorities in the order shown on Overview</span></span>
        <button type="button" className="d-switch" role="switch" aria-checked={settings.auto} aria-label="Reset-first routing"
          onClick={() => updateRoutingSettings({ auto: !settings.auto })} />
      </div>
      <div className="d-srow">
        <span className="d-k"><b>Order</b><span>Automatic sorts by weekly reset. Manual uses your dragged order.</span></span>
        <select className="d-select" value={settings.mode}
          onChange={(event) => updateRoutingSettings({ mode: event.currentTarget.value === 'manual' ? 'manual' : 'automatic' })}>
          <option value="automatic">Automatic</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      <div className="d-srow">
        <span className="d-k"><b>Skip near the 5 hour limit</b><span>New sessions only</span></span>
        <select className="d-select" value={settings.headroomPct}
          onChange={(event) => updateRoutingSettings({ headroomPct: Number(event.currentTarget.value) })}>
          {[80, 85, 90, 95].map((pct) => <option key={pct} value={pct}>{pct}%</option>)}
        </select>
      </div>
      <div className="d-srow">
        <span className="d-k"><b>Skip near the weekly limit</b><span>The rest is kept for sessions already running there</span></span>
        <select className="d-select" value={settings.weeklyCutoffPct}
          onChange={(event) => updateRoutingSettings({ weeklyCutoffPct: Number(event.currentTarget.value) })}>
          {[90, 95, 98, 100].map((pct) => <option key={pct} value={pct}>{pct === 100 ? 'Never' : `${pct}%`}</option>)}
        </select>
      </div>
      <div className="d-srow">
        <span className="d-k"><b>Weekly window to burn first</b><span>Use Fable week when Fable is your main model</span></span>
        <select className="d-select" value={settings.burnWindow}
          onChange={(event) => updateRoutingSettings({ burnWindow: event.currentTarget.value === 'fableWeek' ? 'fableWeek' : 'week' })}>
          <option value="week">Week</option>
          <option value="fableWeek">Fable week</option>
        </select>
      </div>
    </>
  );
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'routing':
      return (
        <>
          <RoutingRows />
          <div className="d-title"><h2>Core routing</h2></div>
          <div className="d-embed"><ConfigPanelPage section="routing" /></div>
        </>
      );
    case 'core':
      return <div className="d-embed"><KernelPage view="home" /></div>;
    case 'versions':
      return <div className="d-embed"><VersionManagementPage /></div>;
    default:
      return <div className="d-embed"><ConfigPanelPage section={section} /></div>;
  }
}

export function SettingsView() {
  const { target, visit } = useDeskNav();
  const [section, setSection] = useState<SettingsSection>(target.settingsSection ?? 'routing');

  useEffect(() => {
    if (target.settingsSection) setSection(target.settingsSection);
  }, [target, visit]);

  return (
    <>
      <div className="d-ph"><h1>Settings</h1></div>
      <div className="d-settings">
        <nav className="d-snav" aria-label="Settings sections">
          {groups.map((group) => (
            <div key={group.label} style={{ display: 'contents' }}>
              <div className="d-grp">{group.label}</div>
              {group.items.map((item) => (
                <button key={item.id} type="button" aria-selected={section === item.id} onClick={() => setSection(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="d-sect" key={section}>
          <h2>{sectionLabel(section)}</h2>
          <SectionBody section={section} />
        </section>
      </div>
    </>
  );
}
