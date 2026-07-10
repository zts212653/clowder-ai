import type { CatProvider } from './types/cat.js';

export const CLI_EFFORT_VALUES = ['low', 'medium', 'high', 'max', 'xhigh'] as const;
/** Maintained cross-client presets shown as suggestions in the Hub. */
export type CliEffortPreset = (typeof CLI_EFFORT_VALUES)[number];
/**
 * A canonical client effort value persisted in the runtime catalog.
 *
 * Providers evolve independently, so a member may use a native value that is
 * not yet part of our maintained preset vocabulary (for example `ultra`).
 */
export type CliEffortValue = string;
export type CliEffortProvider = 'anthropic' | 'openai';
export type CliEffortPatchValue = CliEffortValue | null;

const CLI_EFFORT_OPTIONS_BY_PROVIDER: Record<CliEffortProvider, readonly CliEffortPreset[]> = {
  anthropic: ['low', 'medium', 'high', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
};

const CLI_EFFORT_DEFAULT_BY_PROVIDER: Record<CliEffortProvider, CliEffortPreset> = {
  anthropic: 'max',
  openai: 'xhigh',
};

function isCliEffortProvider(provider: string): provider is CliEffortProvider {
  return provider === 'anthropic' || provider === 'openai';
}

export function getCliEffortOptionsForProvider(provider: CatProvider | string): readonly CliEffortPreset[] | null {
  return isCliEffortProvider(provider) ? CLI_EFFORT_OPTIONS_BY_PROVIDER[provider] : null;
}

export function getDefaultCliEffortForProvider(provider: CatProvider | string): CliEffortPreset | null {
  return isCliEffortProvider(provider) ? CLI_EFFORT_DEFAULT_BY_PROVIDER[provider] : null;
}

export function isValidCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
): effort is CliEffortPreset {
  if (!effort) return false;
  const options = getCliEffortOptionsForProvider(provider);
  return options ? options.includes(effort as CliEffortPreset) : false;
}

export function normalizeCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
): CliEffortValue | null {
  const nativeValue = effort?.trim();
  if (nativeValue) return nativeValue;
  return isCliEffortProvider(provider) ? CLI_EFFORT_DEFAULT_BY_PROVIDER[provider] : null;
}
