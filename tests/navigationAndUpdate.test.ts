import { describe, expect, test } from 'bun:test';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from '../src/navigation';
import { oauthSubpages } from '../src/oauthNavigation';

describe('CPA Desk navigation', () => {
  test('pages that work without the core stay open while it is stopped', () => {
    for (const page of ['overview', 'clients', 'usage', 'settings'] as const) {
      expect(canOpenAppPage(page, false)).toBe(true);
    }
    expect(isAlwaysAvailablePage('accounts')).toBe(false);
    expect(canOpenAppPage('accounts', false)).toBe(false);
    expect(canOpenAppPage('accounts', true)).toBe(true);
  });
});

describe('OAuth 子页面导航', () => {
  test('认证文件和额度查询收纳在 OAuth 页面内', () => {
    expect(oauthSubpages.map((page) => page.id)).toEqual(['login', 'authFiles', 'quota']);
    expect(oauthSubpages.map((page) => page.labelKey)).toEqual([
      'oauth.title',
      'authFiles.title',
      'quota.title',
    ]);
  });
});

describe('软件与内核更新导航提示点', () => {
  test('任一组件有新版都显示橙点，处理中的蓝点优先', () => {
    expect(appUpdateIndicatorState(true, false, false)).toBe('available');
    expect(appUpdateIndicatorState(false, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, false, true)).toBe('processing');
    expect(appUpdateIndicatorState(false, true, true)).toBe('processing');
  });

  test('最新版或检查失败都不显示提示点', () => {
    expect(appUpdateIndicatorState(false, false, false)).toBeNull();
  });
});
