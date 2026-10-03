import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { TrayPanel } from './TrayPanel';
import { I18nProvider } from './i18n';
import { initializeTheme } from './theme';
import './styles/index.css';
import './styles/app.css';

async function bootstrap() {
  if (import.meta.env.DEV && !isTauri()) {
    const { installBrowserMock } = await import('./mocks/browserMock');
    installBrowserMock();
  }

  initializeTheme();

  // The menu bar popover is a second window running the same bundle.
  const isTrayWindow = isTauri()
    && (await import('@tauri-apps/api/webviewWindow')).getCurrentWebviewWindow().label === 'tray';
  // Browser preview: `?panel` shows the popover next to the app (events are in-page there).
  const previewPanel = !isTauri() && new URLSearchParams(window.location.search).has('panel');
  if (isTrayWindow) document.documentElement.classList.add('d-tray-window');

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          {isTrayWindow ? <TrayPanel /> : <App />}
          {previewPanel ? <div style={{ position: 'fixed', top: 8, right: 8, zIndex: 50 }}><TrayPanel /></div> : null}
        </AppErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
