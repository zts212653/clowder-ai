import { describe, expect, it } from 'vitest';
import { resolveConsoleSetupState } from '../settings/console-setup-state';

describe('resolveConsoleSetupState', () => {
  it('returns a setup state for runtime-backed settings sections when config fetch fails', () => {
    expect(resolveConsoleSetupState('members', '网络错误')).toMatchObject({
      title: 'Console 还没连上运行时',
      href: '/classic',
    });
    expect(resolveConsoleSetupState('system', '配置加载失败')).toMatchObject({
      title: 'Console 还没连上运行时',
      href: '/classic',
    });
    expect(resolveConsoleSetupState('skills', '网络错误')).toMatchObject({
      title: 'Console 还没连上运行时',
      href: '/classic',
    });
  });

  it('does not short-circuit unknown sections or healthy states', () => {
    expect(resolveConsoleSetupState('unknown', '网络错误')).toBeNull();
    expect(resolveConsoleSetupState('members', null)).toBeNull();
  });
});
