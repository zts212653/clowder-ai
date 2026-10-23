import { isAlias, isMap, isSeq, parseDocument, stringify, visit, type YAMLMap } from 'yaml';
import { assertDshCopyPolicy } from './dsh-setup-copy-policy.js';

export interface DshSetupInfo {
  providers: { id: string; models: { id: string; label: string }[] }[];
  provider?: string;
  model?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const modelPlugins = new Set(['llm-pi-ai', 'acp', 'agent-default-model', 'llm-deepseek']);

function plugins(source: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || !isSeq(document.contents)) throw Error('dsh_config_invalid');
  const result = new Map<string, YAMLMap>();
  for (const row of document.contents.items) {
    if (!isMap(row)) continue;
    if (['insert', 'remove', 'before', 'after'].some((key) => row.has(key))) throw Error('dsh_config_complex_patch');
    const id: unknown = row.get('id');
    if (typeof id !== 'string' || !modelPlugins.has(id)) continue;
    if (result.has(id)) throw Error('dsh_config_ambiguous');
    const disabled: unknown = row.get('disabled');
    if (disabled === true) {
      if (id === 'llm-deepseek') continue;
      throw Error('dsh_plugin_disabled');
    }
    result.set(id, row);
  }
  return result;
}
function config(plugin: YAMLMap | undefined): Record<string, unknown> {
  const node = plugin?.get('config', true);
  if (node === undefined) return {};
  // Never evaluate !!js or turn an expression into a literal. Unknown tags in
  // unrelated plugins are irrelevant; only relevant model configurations are decoded.
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
    defaults: config(entries.get('agent-default-model')),
    native: config(entries.get('llm-deepseek')),
    hasNative: entries.has('llm-deepseek'),
    hasAcp: entries.has('acp'),
    hasLlm: entries.has('llm-pi-ai'),
  };
}
/** Ignore diagnostic source comments (which name disposable snapshot paths). */
export function canonicalDshConfig(source: string): string {
  return JSON.stringify(configs(source));
}
export function inspectDshConfig(source: string): DshSetupInfo {
  const { llm, acp, defaults, native, hasNative } = configs(source);
  const provider = text(acp.provider) ?? text(defaults.provider);
  const selected = text(acp.model) ?? text(defaults.model);
  const providers = { ...object(llm.providers) };
  if (hasNative) {
    if (Object.hasOwn(providers, 'deepseek-official')) throw Error('dsh_config_ambiguous');
    providers['deepseek-official'] = {
      models: Array.isArray(native.models)
        ? native.models
        : provider === 'deepseek-official' && selected
          ? [{ id: selected }]
          : [],
    };
  }
  return {
    providers: Object.entries(providers).map(([id, profile]) => ({
      id,
      models: (Array.isArray(object(profile).models)
        ? (object(profile).models as unknown[])
        : id === provider && selected
          ? [{ id: selected }]
          : []
      ).flatMap((model) => {
        const item = object(model),
          id = text(item.id);
        return id ? [{ id, label: text(item.name) ?? id }] : [];
      }),
    })),
    provider,
    model: selected,
  };
}
/** Credential references only. Neither secret values nor endpoints leave the server. */
export function dshProviderCredentialReferences(source: string): Record<string, string | undefined> {
  const { llm, native, hasNative } = configs(source);
  const reference = (route: Record<string, unknown>) => {
    if (!Object.hasOwn(route, 'apiKeyEnv')) return undefined;
    if (typeof route.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.apiKeyEnv))
      throw Error('dsh_config_invalid');
    return route.apiKeyEnv;
  };
  return Object.fromEntries([
    ...Object.entries(object(llm.providers)).map(([id, route]) => [id, reference(object(route))]),
    ...(hasNative ? [['deepseek-official', reference(native) ?? 'DEEPSEEK_API_KEY']] : []),
  ]);
}
/** Desktop is reserved to Electron in some CLI versions. Reuse only explicitly
 * stored declarations, with the home layer replacing the full plugin config. */
export function composeDshProviderSource(profilePatch: string, homePatch: string): string {
  const profile = plugins(profilePatch),
    home = plugins(homePatch);
  return stringify(
    [
      'llm-pi-ai',
      'agent-default-model',
      ...(profile.has('llm-deepseek') || home.has('llm-deepseek') ? ['llm-deepseek'] : []),
    ].map((id) => ({
      id,
      config: config(home.get(id)?.has('config') ? home.get(id) : profile.get(id)),
    })),
  );
}
export function buildDshPatch(active: string, source: string, provider: string, model: string): string {
  const current = configs(active),
    from = configs(source);
  if (!current.hasAcp || !current.hasLlm) throw Error('dsh_acp_missing');
  if (
    !inspectDshConfig(source).providers.some(
      (route) => route.id === provider && route.models.some((m) => m.id === model),
    )
  )
    throw Error('dsh_selection_invalid');
  const nativeSelection = provider === 'deepseek-official' && from.hasNative;
  const providers = {
    ...object(current.llm.providers),
    ...(!nativeSelection ? { [provider]: object(from.llm.providers)[provider] } : {}),
  };
  if (nativeSelection && !current.hasNative) throw Error('dsh_selection_invalid');
  const llmConfig = { ...current.llm, providers };
  const acpConfig = { ...current.acp, provider, model };
  const nativeConfig = nativeSelection ? { ...current.native, ...from.native } : undefined;
  assertDshCopyPolicy(llmConfig, acpConfig, nativeConfig);
  const patch = [
    ...(nativeConfig ? [{ id: 'llm-deepseek', config: nativeConfig }] : []),
    { id: 'llm-pi-ai', config: llmConfig },
    { id: 'acp', config: acpConfig },
  ];
  return stringify(patch);
}
