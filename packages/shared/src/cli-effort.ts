import type { CatProvider } from './types/cat.js';

export const CLI_EFFORT_VALUES = ['low', 'medium', 'high', 'max', 'xhigh', 'ultra'] as const;
/** Maintained cross-client presets used by thread overrides and Hub suggestions. */
export type CliEffortPreset = (typeof CLI_EFFORT_VALUES)[number];
/** Canonical non-empty provider-native value persisted on a member. */
export type CliEffortValue = string;
export type CliEffortProvider = 'anthropic' | 'openai' | 'kimi';
export type CliEffortPatchValue = CliEffortPreset | null;
export type CliEffortOverrideSource = 'thread_override' | 'inherited';
export type CliEffortOverrideCompatibility = 'compatible' | 'incompatible';

export interface CliEffortOverrideResolution {
  effective: CliEffortValue;
  source: CliEffortOverrideSource;
  compatibility: CliEffortOverrideCompatibility;
}

const CLI_EFFORT_OPTIONS_BY_PROVIDER: Record<CliEffortProvider, readonly CliEffortPreset[]> = {
  anthropic: ['low', 'medium', 'high', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
  // Fallback for effort-capable Kimi models; gated per-model below — only the
  // k3 family declares support_efforts (low/high/max, no medium). Boolean-thinking
  // Kimi models (kimi-for-coding, k2.x) get null from getCliEffortOptionsForProvider.
  kimi: ['low', 'high', 'max'],
};

const GPT_5_6_OPENAI_EFFORT_OPTIONS: readonly CliEffortPreset[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const CLI_EFFORT_DEFAULT_BY_PROVIDER: Record<CliEffortProvider, CliEffortPreset> = {
  anthropic: 'max',
  openai: 'xhigh',
  kimi: 'high',
};

function isCliEffortProvider(provider: string): provider is CliEffortProvider {
  return provider === 'anthropic' || provider === 'openai' || provider === 'kimi';
}

export function normalizeModelSlug(model: string | null | undefined): string | null {
  return model?.trim().toLowerCase().split('/').filter(Boolean).at(-1) ?? null;
}

function isGpt56Model(model: string | null | undefined): boolean {
  const modelId = normalizeModelSlug(model);
  return modelId ? /^gpt-5\.6(?:-|$)/.test(modelId) : false;
}

/**
 * Only the Kimi k3 family declares support_efforts in kimi-code config.toml
 * (low/high/max). kimi-for-coding and k2.x models are boolean-thinking and
 * expose no effort tiers.
 */
function isKimiEffortCapableModel(model: string | null | undefined): boolean {
  const modelId = normalizeModelSlug(model);
  return modelId ? /^k3(?:-|$)/.test(modelId) : false;
}

export function getCliEffortOptionsForProvider(
  provider: CatProvider | string,
  model?: string | null,
): readonly CliEffortPreset[] | null {
  if (!isCliEffortProvider(provider)) return null;
  if (provider === 'openai' && isGpt56Model(model)) return GPT_5_6_OPENAI_EFFORT_OPTIONS;
  if (provider === 'kimi') return isKimiEffortCapableModel(model) ? CLI_EFFORT_OPTIONS_BY_PROVIDER.kimi : null;
  return CLI_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultCliEffortForProvider(provider: CatProvider | string): CliEffortPreset | null {
  return isCliEffortProvider(provider) ? CLI_EFFORT_DEFAULT_BY_PROVIDER[provider] : null;
}

export function isValidCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
  model?: string | null,
): effort is CliEffortPreset {
  if (!effort) return false;
  const options = getCliEffortOptionsForProvider(provider, model);
  return options ? options.includes(effort as CliEffortPreset) : false;
}

export function normalizeCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
  _model?: string | null,
): CliEffortValue | null {
  if (!isCliEffortProvider(provider)) return null;
  const nativeValue = effort?.trim();
  if (nativeValue) return nativeValue;
  return CLI_EFFORT_DEFAULT_BY_PROVIDER[provider];
}

/**
 * Project a raw thread override against the invocation's effective model.
 * The raw value remains stored even while temporarily incompatible.
 */
export function resolveCliEffortOverride(
  provider: CatProvider | string,
  model: string | null | undefined,
  inherited: CliEffortValue,
  override: CliEffortPreset | null | undefined,
): CliEffortOverrideResolution {
  if (!override) {
    return { effective: inherited, source: 'inherited', compatibility: 'compatible' };
  }
  if (!isValidCliEffortForProvider(provider, override, model)) {
    return { effective: inherited, source: 'inherited', compatibility: 'incompatible' };
  }
  return { effective: override, source: 'thread_override', compatibility: 'compatible' };
}
