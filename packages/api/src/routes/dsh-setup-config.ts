import { isAlias, isMap, isSeq, parseDocument, stringify, visit, type YAMLMap } from 'yaml';
import { assertDshCopyPolicy, assertDshNativeCopyPolicy } from './dsh-setup-copy-policy.js';

export interface DshSetupInfo {
  providers: { id: string; models: { id: string; label: string }[] }[];
  provider?: string;
  model?: string;
  defaultEffort?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function plugins(source: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || !isSeq(document.contents)) throw Error('dsh_config_invalid');
  const result = new Map<string, YAMLMap>();
  for (const row of document.contents.items) {
    if (!isMap(row)) continue;
    if (['insert', 'remove', 'before', 'after'].some((key) => row.has(key))) throw Error('dsh_config_complex_patch');
    const id: unknown = row.get('id');
    if (
      typeof id !== 'string' ||
      !['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'agent-default-model', 'acp'].includes(id)
    )
      continue;
    if (result.has(id)) throw Error('dsh_config_ambiguous');
    const disabled: unknown = row.get('disabled');
    if (disabled === true) throw Error('dsh_plugin_disabled');
    result.set(id, row);
  }
  return result;
}
function config(plugin: YAMLMap | undefined): Record<string, unknown> {
  const node = plugin?.get('config', true);
  if (node === undefined) return {};
  // Never evaluate !!js or turn an expression into a literal. Unknown tags in
  // unrelated plugins are irrelevant; only the two copied configs are decoded.
  visit(node, (_key, value) => {
    const tag = text(object(value).tag);
    if (isAlias(value) || (tag && !/^tag:yaml.org,2002:(?:map|seq|str|int|float|bool|null)$/.test(tag)))
      throw Error('dsh_config_expression');
  });
  if (!isMap(node)) throw Error('dsh_config_invalid');
  return object(node.toJSON());
}
function configs(source: string) {
  const entries = plugins(source);
  return {
    llm: config(entries.get('llm-pi-ai')),
    acp: config(entries.get('acp')),
    native: config(entries.get('llm-deepseek')),
    nativeAccount: config(entries.get('llm-deepseek-account')),
    defaults: config(entries.get('agent-default-model')),
    hasNative: entries.has('llm-deepseek'),
    hasNativeAccount: entries.has('llm-deepseek-account'),
    hasAcp: entries.has('acp'),
    hasLlm: entries.has('llm-pi-ai'),
  };
}
/** Ignore diagnostic source comments (which name disposable snapshot paths). */
export function canonicalDshConfig(source: string): string {
  return JSON.stringify(configs(source));
}
export function inspectDshConfig(source: string): DshSetupInfo {
  const { llm, acp, native, nativeAccount, defaults, hasNative, hasNativeAccount } = configs(source);
  return {
    providers: [
      ...Object.entries(object(llm.providers)),
      ...(hasNative ? [['deepseek-official', native] as const] : []),
      ...(hasNativeAccount ? [['deepseek-account', nativeAccount] as const] : []),
    ].map(([id, profile]) => ({
      id,
      models: (Array.isArray(object(profile).models) ? (object(profile).models as unknown[]) : []).flatMap((model) => {
        const item = object(model),
          id = text(item.id);
        return id ? [{ id, label: text(item.name) ?? id }] : [];
      }),
    })),
    provider: text(acp.provider) ?? text(defaults.provider),
    model: text(acp.model) ?? text(defaults.model),
    ...(text(defaults.reasoningEffort) ? { defaultEffort: text(defaults.reasoningEffort) } : {}),
  };
}
/** Desktop is reserved to Electron in some CLI versions. Reuse only explicitly
 * stored declarations, with the home layer replacing the full plugin config. */
export function composeDshProviderSource(profilePatch: string, homePatch: string): string {
  const profile = plugins(profilePatch),
    home = plugins(homePatch);
  return stringify(
    ['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'agent-default-model'].flatMap((id) => {
      const entry = home.get(id)?.has('config') ? home.get(id) : profile.get(id);
      return entry ? [{ id, config: config(entry) }] : [];
    }),
  );
}

/** A process-local overlay follows the native default without editing its profile. */
export function buildDshNativePatch(source: string, active = '[]'): string {
  const from = configs(source),
    selected = inspectDshConfig(source);
  if (!selected.provider || !selected.model) throw Error('dsh_default_unreported');
  if (
    !['deepseek-official', 'deepseek-account'].includes(selected.provider) &&
    !selected.providers.some((provider) => provider.id === selected.provider)
  )
    throw Error('dsh_default_unavailable');
  const acpConfig = { ...configs(active).acp, provider: selected.provider, model: selected.model };
  assertDshCopyPolicy(from.hasLlm ? from.llm : { providers: {} }, acpConfig);
  if (from.hasNative) assertDshNativeCopyPolicy(from.native);
  if (from.hasNativeAccount) assertDshNativeCopyPolicy(from.nativeAccount);
  return stringify([
    ...(from.hasLlm ? [{ id: 'llm-pi-ai', config: from.llm }] : []),
    ...(from.hasNative ? [{ id: 'llm-deepseek', config: from.native }] : []),
    ...(from.hasNativeAccount ? [{ id: 'llm-deepseek-account', config: from.nativeAccount }] : []),
    { id: 'agent-default-model', config: from.defaults },
    // ACP requires an explicit initial selection to advertise model options.
    { id: 'acp', config: acpConfig },
  ]);
}
export function buildDshPatch(active: string, source: string, provider: string, model: string): string {
  const current = configs(active),
    from = configs(source);
  if (!current.hasAcp) throw Error('dsh_acp_missing');
  if (
    !inspectDshConfig(source).providers.some(
      (route) => route.id === provider && route.models.some((m) => m.id === model),
    )
  )
    throw Error('dsh_selection_invalid');
  if (provider === 'deepseek-official' && from.hasNative) {
    assertDshNativeCopyPolicy(from.native);
    return stringify([
      { id: 'llm-deepseek', config: from.native },
      { id: 'acp', config: { ...current.acp, provider, model } },
    ]);
  }
  const providers = { ...object(current.llm.providers), [provider]: object(from.llm.providers)[provider] };
  const llmConfig = { ...current.llm, providers };
  const acpConfig = { ...current.acp, provider, model };
  assertDshCopyPolicy(llmConfig, acpConfig);
  return stringify([
    { id: 'llm-pi-ai', config: llmConfig },
    { id: 'acp', config: acpConfig },
  ]);
}
