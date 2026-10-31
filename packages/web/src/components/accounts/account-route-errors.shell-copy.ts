import { defineShellCopy } from '../shell/shell-copy';

/** Dynamic errors produced by accounts routes: only the framing is translated. */
export const accountRouteErrorsCopy = defineShellCopy(
  {
    zh: {
      notFound: (ref: string) => `找不到账号「${ref}」`,
      referenced: (ref: string, members: string) =>
        `账号「${ref}」仍被引用：${members}。请先移除绑定，或提交 { "force": true }。`,
      referencesUnknown: (reason: string) => `无法核对账号引用：${reason}。可提交 { "force": true } 覆盖此检查。`,
      sharedStore: (ref: string, path: string) =>
        `账号「${ref}」位于共享配置 ${path}，普通删除无法核对其他项目的绑定。请核对所有项目配置，或提交 { "force": true }。`,
      parseConfig: (path: string) => `无法解析配置 ${path}`,
      missingMember: (id: string) => `候选成员配置缺少「${id}」`,
      runtimeCopy: (ref: string) => `账号「${ref}」在运行环境中还有副本，请核对一致后再编辑`,
      conflict: (ref: string, reason: string) => `账号「${ref}」配置冲突：${reason}`,
      incompatible: (ref: string, client: string) => `绑定账号「${ref}」与工具「${client}」不兼容`,
      endpointUserinfo: (ref: string) => `账号「${ref}」的服务商地址不能包含用户名或密码`,
      endpointIdentity: (ref: string, protocol: string, family: string) =>
        `绑定账号「${ref}」的身份与 ${family} 官方端点的 ${protocol} 协议不兼容`,
      invalidRoot: (path: string) => `账号配置根目录无法解析：目录无效 ${path}`,
    },
    en: {
      notFound: (ref: string) => `Account "${ref}" not found`,
      referenced: (ref: string, members: string) =>
        `Account "${ref}" is still referenced by: ${members}. Remove bindings first or pass { "force": true }.`,
      referencesUnknown: (reason: string) =>
        `Cannot verify account references — ${reason}. Pass { "force": true } to override.`,
      sharedStore: (ref: string, path: string) =>
        `Account "${ref}" lives in shared global store ${path} and non-force deletion cannot verify bindings in other projects. Audit all project catalogs or pass { "force": true }.`,
      parseConfig: (path: string) => `config at ${path} failed to parse`,
      missingMember: (id: string) => `Cat "${id}" missing from the candidate catalog`,
      runtimeCopy: (ref: string) => `account "${ref}" has a runtime copy; reconcile before editing`,
      conflict: (ref: string, reason: string) => `Account conflict for "${ref}": ${reason}`,
      incompatible: (ref: string, client: string) =>
        `bound provider profile "${ref}" is incompatible with client "${client}"`,
      endpointUserinfo: (ref: string) => `account "${ref}" endpoint URL must not contain userinfo`,
      endpointIdentity: (ref: string, protocol: string, family: string) =>
        `bound provider profile "${ref}" identity is incompatible with ${protocol} at official ${family} endpoint`,
      invalidRoot: (path: string) => `accounts root unresolvable: invalid directory ${path}`,
    },
  },
  {
    samples: {
      notFound: [['stale'], ['other']],
      referenced: [
        ['stale', 'sol'],
        ['other', 'astra'],
      ],
      referencesUnknown: [['Fixture unavailable'], ['Fixture conflict']],
      sharedStore: [
        ['stale', '/fixture/a'],
        ['other', '/fixture/b'],
      ],
      parseConfig: [['/fixture/a'], ['/fixture/b']],
      missingMember: [['sol'], ['astra']],
      runtimeCopy: [['stale'], ['other']],
      conflict: [
        ['stale', 'Fixture unavailable'],
        ['other', 'Fixture conflict'],
      ],
      incompatible: [
        ['stale', 'openai'],
        ['other', 'anthropic'],
      ],
      endpointUserinfo: [['team-a'], ['team-b']],
      endpointIdentity: [
        ['team-a', 'openai', 'kimi'],
        ['team-b', 'openai-responses', 'openai'],
      ],
      invalidRoot: [['/fixture/a'], ['/fixture/b']],
    },
  },
);
