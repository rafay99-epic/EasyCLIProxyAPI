import type { DeskPage } from './deskNav';

// Pages that talk to the core's management API need it running; the rest work offline.
const alwaysAvailablePages = new Set<DeskPage>(['overview', 'clients', 'usage', 'settings']);

export function isAlwaysAvailablePage(pageId: DeskPage) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: DeskPage, coreReady: boolean) {
  return coreReady || isAlwaysAvailablePage(pageId);
}
