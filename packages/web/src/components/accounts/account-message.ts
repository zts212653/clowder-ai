import { resolveShellCopy } from '../shell/shell-copy';
import type { ShellLanguage } from '../shell/shell-language';
import { accountErrorsCopy } from './account-errors.shell-copy';
import { accountRouteErrorsCopy } from './account-route-errors.shell-copy';

function englishAccountMessage(message: string): string {
  const http = /^(创建|更新)失败 \((\d+)\)$/.exec(message);
  if (http) return `${http[1] === '创建' ? 'Creation' : 'Update'} failed (${http[2]})`;
  const window = /^(GPT-5\.3-Codex-Spark )?(\d+)(小时|天)使用限额$/.exec(message);
  if (window) return `${window[1] ?? ''}${window[2]}-${window[3] === '小时' ? 'hour' : 'day'} usage limit`;
  if (message === 'GPT-5.3-Codex-Spark 每周使用限额') return 'GPT-5.3-Codex-Spark weekly usage limit';
  return message;
}

function chineseAccountMessage(message: string): string {
  const orphan = /^account "([^"]+)" has a torn credential without account metadata; reconcile before use$/.exec(
    message,
  );
  if (orphan) return `账号「${orphan[1]}」有凭据但缺少账号信息，请核对配置后再使用`;
  const torn = /^account "([^"]+)" is torn across workspace\/runtime stores; reconcile before use$/.exec(message);
  if (torn) return `账号「${torn[1]}」在工作区与运行环境的配置不完整，请核对后再使用`;
  const divergent = /^account "([^"]+)" is divergent between workspace\/runtime stores; reconcile before use$/.exec(
    message,
  );
  if (divergent) return `账号「${divergent[1]}」在工作区与运行环境的配置不一致，请核对后再使用`;
  const malformed = /^Invalid\/malformed account store \((.+)\); repair it before use$/.exec(message);
  if (malformed) return `账号配置无法解析（${malformed[1]}），请修正后再使用`;
  return message;
}

/** Anchored to known account-route formats; never translate a generic error prefix. */
function accountRouteMessage(message: string, language: ShellLanguage): string | undefined {
  const t = resolveShellCopy(accountRouteErrorsCopy, language);
  const parseReason = (reason: string) => {
    const config = /^config at (.+) failed to parse$/.exec(reason);
    return config ? t.parseConfig(config[1]) : reason;
  };
  const formats: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    [/^Account "([^"\n]+)" not found$/, (m) => t.notFound(m[1])],
    [
      /^Account "([^"\n]+)" is still referenced by: (.+)\. Remove bindings first or pass \{ "force": true \}\.$/,
      (m) => t.referenced(m[1], m[2]),
    ],
    [
      /^Cannot verify account references — (.+)\. Pass \{ "force": true \} to override\.$/,
      (m) => t.referencesUnknown(parseReason(m[1])),
    ],
    [
      /^Account "([^"\n]+)" lives in shared global store (.+) and non-force deletion cannot verify bindings in other projects\. Audit all project catalogs or pass \{ "force": true \}\.$/,
      (m) => t.sharedStore(m[1], m[2]),
    ],
    [/^config at (.+) failed to parse$/, (m) => t.parseConfig(m[1])],
    [/^Cat "([^"\n]+)" missing from the candidate catalog$/, (m) => t.missingMember(m[1])],
    [/^account "([^"\n]+)" has a runtime copy; reconcile before editing$/, (m) => t.runtimeCopy(m[1])],
    [/^Account conflict for "([^"\n]+)": (.+)$/, (m) => t.conflict(m[1], m[2])],
    [/^bound provider profile "([^"\n]+)" is incompatible with client "([^"\n]+)"$/, (m) => t.incompatible(m[1], m[2])],
    [/^account "([^"\n]+)" endpoint URL must not contain userinfo$/, (m) => t.endpointUserinfo(m[1])],
    [
      /^bound provider profile "([^"\n]+)" identity is incompatible with (anthropic|openai|openai-responses|google|kimi) at official (anthropic|openai|google|kimi) endpoint$/,
      (m) => t.endpointIdentity(m[1], m[2], m[3]),
    ],
    [/^accounts root unresolvable: invalid directory (.+)$/, (m) => t.invalidRoot(m[1])],
  ];
  for (const [pattern, format] of formats) {
    const match = pattern.exec(message);
    if (match) return format(match);
  }
}

/** Translate known product errors without rewriting server facts or unknown diagnostics. */
export function accountMessage(message: string, language: ShellLanguage): string {
  const t = resolveShellCopy(accountErrorsCopy, language);
  if (Object.hasOwn(t, message)) return t[message as keyof typeof t];
  const routeMessage = accountRouteMessage(message, language);
  if (routeMessage !== undefined) return routeMessage;
  return language === 'en' ? englishAccountMessage(message) : chineseAccountMessage(message);
}
