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

function plugins(source: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || !isSeq(document.contents)) throw Error('dsh_config_invalid');
  const result = new Map<string, YAMLMap>();
  for (const row of document.contents.items) {
    if (!isMap(row)) continue;
    if (['insert', 'remove', 'before', 'after'].some((key) => row.has(key))) throw Error('dsh_config_complex_patch');
    const id: unknown = row.get('id');
    if (id !== 'llm-pi-ai' && id !== 'acp') continue;
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
    hasAcp: entries.has('acp'),
    hasLlm: entries.has('llm-pi-ai'),
  };
}
/** Ignore diagnostic source comments (which name disposable snapshot paths). */
export function canonicalDshConfig(source: string): string {
  return JSON.stringify(configs(source));
}
export function inspectDshConfig(source: string): DshSetupInfo {
  const { llm, acp } = configs(source);
  return {
    providers: Object.entries(object(llm.providers)).map(([id, profile]) => ({
      id,
      models: (Array.isArray(object(profile).models) ? (object(profile).models as unknown[]) : []).flatMap((model) => {
        const item = object(model),
          id = text(item.id);
        return id ? [{ id, label: text(item.name) ?? id }] : [];
      }),
    })),
    provider: text(acp.provider),
    model: text(acp.model),
  };
}
/** Desktop is reserved to Electron in some CLI versions. Reuse only explicitly
 * stored declarations, with the home layer replacing the full plugin config. */
export function composeDshProviderSource(profilePatch: string, homePatch: string): string {
  const profile = plugins(profilePatch).get('llm-pi-ai'),
    home = plugins(homePatch).get('llm-pi-ai');
  return stringify([{ id: 'llm-pi-ai', config: config(home?.has('config') ? home : profile) }]);
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
  const providers = { ...object(current.llm.providers), [provider]: object(from.llm.providers)[provider] };
  const llmConfig = { ...current.llm, providers };
  const acpConfig = { ...current.acp, provider, model };
  assertDshCopyPolicy(llmConfig, acpConfig);
  return stringify([
    { id: 'llm-pi-ai', config: llmConfig },
    { id: 'acp', config: acpConfig },
  ]);
}
