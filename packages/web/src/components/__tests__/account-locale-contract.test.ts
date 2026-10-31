import { describe, expect, it } from 'vitest';
import { accountMessage } from '../accounts/account-message';
import { accountsCopy } from '../accounts/accounts.shell-copy';

describe('account count semantics', () => {
  for (const n of [0, 1, 3]) {
    it(`uses singular only for one member/account (${n}) throughout the journey`, () => {
      const member = n === 1 ? 'member' : 'members';
      const account = n === 1 ? 'account' : 'accounts';
      const t = accountsCopy.en;
      expect(t.switchCount(n)).toBe(`${n} ${member} will switch:`);
      expect(t.exceptionCount(n, 'Fixture')).toBe(`${n} ${member} on other accounts: Fixture`);
      expect(t.memberCount(n)).toBe(` ${n} ${member}`);
      expect(t.rejectedCount(n)).toBe(`${n} unavailable legacy ${account}`);
      expect(t.boundDelete(n)).toBe(
        `${n} ${member} still ${n === 1 ? 'uses' : 'use'} it; switch ${n === 1 ? 'this member' : 'them'} first.`,
      );
      expect(t.mixed(n, 'Fixture')).toContain(`${n} ${account}: Fixture`);
    });
  }
});
describe('known account route errors preserve facts in the selected language', () => {
  it.each([
    [
      'Identity required (session cookie or X-Cat-Cafe-User header)',
      '需要登录身份（session cookie 或 X-Cat-Cafe-User header）',
    ],
    ['Invalid project path', '项目路径无效'],
    [
      'Invalid project path: must be an existing directory under allowed roots',
      '项目路径无效：须为允许范围内的现有目录',
    ],
    ['Account "stale" not found', '找不到账号「stale」'],
    ['Account "stale-b" not found', '找不到账号「stale-b」'],
    [
      'Account "stale" is still referenced by: sol, astra. Remove bindings first or pass { "force": true }.',
      '账号「stale」仍被引用：sol, astra。请先移除绑定，或提交 { "force": true }。',
    ],
    [
      'Cannot verify account references — config at /fixture/catalog.json failed to parse. Pass { "force": true } to override.',
      '无法核对账号引用：无法解析配置 /fixture/catalog.json。可提交 { "force": true } 覆盖此检查。',
    ],
    [
      'Account "stale" lives in shared global store /fixture/store and non-force deletion cannot verify bindings in other projects. Audit all project catalogs or pass { "force": true }.',
      '账号「stale」位于共享配置 /fixture/store，普通删除无法核对其他项目的绑定。请核对所有项目配置，或提交 { "force": true }。',
    ],
    ['Cat "sol" missing from the candidate catalog', '候选成员配置缺少「sol」'],
    [
      'account "stale" has a runtime copy; reconcile before editing',
      '账号「stale」在运行环境中还有副本，请核对一致后再编辑',
    ],
    ['Account conflict for "stale": model list differs', '账号「stale」配置冲突：model list differs'],
    ['Binding unavailable', '换绑暂不可用'],
    ['Codex login unavailable', 'Codex 登录暂不可用'],
  ])('normalizes %s', (raw, expected) => {
    expect(accountMessage(raw, 'zh')).toBe(expected);
    expect(accountMessage(raw, 'en')).toBe(raw);
  });
  it.each([
    'Identity required (unknown policy)',
    'Invalid project path: new provider diagnostic',
    'Account "stale" not found in a third-party cache',
    'upstream: Account "stale" not found',
    'provider diagnostic: 未知细节',
  ])('leaves an unknown diagnostic intact: %s', (raw) => {
    expect(accountMessage(raw, 'zh')).toBe(raw);
    expect(accountMessage(raw, 'en')).toBe(raw);
  });
});

describe('binding and login errors from account route dependencies', () => {
  it.each([
    [
      'Provider base URL must be an absolute HTTP(S) URL',
      '服务商地址须为完整的 HTTP(S) URL',
      'Provider base URL must be an absolute HTTP(S) URL',
    ],
    ['Provider base URL must use HTTP(S)', '服务商地址须使用 HTTP(S)', 'Provider base URL must use HTTP(S)'],
    [
      'account "team-a" endpoint URL must not contain userinfo',
      '账号「team-a」的服务商地址不能包含用户名或密码',
      'account "team-a" endpoint URL must not contain userinfo',
    ],
    [
      'bound provider profile "team-a" identity is incompatible with openai at official kimi endpoint',
      '绑定账号「team-a」的身份与 kimi 官方端点的 openai 协议不兼容',
      'bound provider profile "team-a" identity is incompatible with openai at official kimi endpoint',
    ],
    [
      'bound provider profile "team-b" identity is incompatible with openai-responses at official openai endpoint',
      '绑定账号「team-b」的身份与 openai 官方端点的 openai-responses 协议不兼容',
      'bound provider profile "team-b" identity is incompatible with openai-responses at official openai endpoint',
    ],
    [
      'Binding preview changed; please review it again',
      '换号影响已变化，请重新预览确认',
      'The account switch preview changed. Review it again.',
    ],
    [
      'codex_managed_layout_changed',
      '托管账号目录已改变，请核对账号配置',
      'Managed account directories changed. Check the account configuration.',
    ],
    ['codex_managed_layout_invalid', '托管账号目录配置无效', 'The managed account directory configuration is invalid.'],
    ['codex_account_config_unreadable', 'Codex 账号配置读不到', 'The Codex account configuration could not be read.'],
    ['codex_account_config_invalid', 'Codex 账号配置无效', 'The Codex account configuration is invalid.'],
    [
      'codex_managed_account_ref_invalid',
      '托管 Codex 账号标识无效',
      'The managed Codex account identifier is invalid.',
    ],
    [
      'codex_account_not_prepared',
      '托管 Codex 账号目录尚未准备完成',
      'The managed Codex account directories are not prepared.',
    ],
  ])('translates the known dependency output %s without losing facts', (raw, zh, en) => {
    expect(accountMessage(raw, 'zh')).toBe(zh);
    expect(accountMessage(raw, 'en')).toBe(en);
  });
  it.each([
    'Provider base URL must use FTP',
    'account "team-a" endpoint URL must not contain userinfo in provider cache',
    'bound provider profile "team-a" identity is incompatible with ftp at official kimi endpoint',
    'codex_managed_layout_changed: unexpected provider detail',
    'upstream: codex_managed_layout_invalid',
  ])('preserves an unknown or near-matching dependency diagnostic: %s', (raw) => {
    expect(accountMessage(raw, 'zh')).toBe(raw);
    expect(accountMessage(raw, 'en')).toBe(raw);
  });
});
