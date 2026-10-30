/**
 * Admission-time runtime selection (model / effort / configuration source).
 *
 * Captured synchronously when an invocation is admitted, from the same member
 * snapshot as FrozenExecutionBinding.catConfig, so a provider that waits for a
 * pool lease or another async step still sends the values this invocation was
 * admitted with. Edits made while the invocation waits apply to the next one.
 *
 * Three facts stay separate: what was saved (`saved*`), what this invocation
 * requests and where it came from (`model` / `inheritedEffort`), and what the
 * native client actually adopted (reported later by the provider, never
 * copied from the request here).
 */

import type { CatConfig, ClientId } from '@cat-cafe/shared';
import { usesNativeToolConfiguration } from '../../../../../config/cat-account-binding.js';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModelEnvKey } from '../../../../../config/cat-models.js';

export type RuntimeModelSource = 'native_tool' | 'env_override' | 'member_config' | 'unresolved';
export type RuntimeEffortSource = 'member_config' | 'client_default' | 'native_inherit';

export interface FrozenRuntimeSelection {
  readonly catId: string;
  readonly configurationSource: CatConfig['configurationSource'] | undefined;
  readonly nativeTool: boolean;
  /** native_tool without a bound account: the client's own login is used. */
  readonly nativeAuthentication: boolean;
  /** Requested model for this invocation; '' = inherit the native client's own default. */
  readonly model: string;
  readonly modelSource: RuntimeModelSource;
  /**
   * Member/inherited effort before any per-thread override; '' = inherit native
   * config; null = no member snapshot (use {@link inheritedEffortFor}).
   */
  readonly inheritedEffort: string | null;
  readonly effortSource: RuntimeEffortSource;
  /** Saved member preferences exactly as configured (no UI placeholder values). */
  readonly savedModel: string | undefined;
  readonly savedEffort: string | undefined;
}

function resolveModel(catId: string, catConfig: CatConfig | undefined, nativeTool: boolean) {
  if (nativeTool) return { model: catConfig?.defaultModel ?? '', modelSource: 'native_tool' as const };
  const envValue = process.env[getCatModelEnvKey(catId)]?.trim();
  if (envValue) return { model: envValue, modelSource: 'env_override' as const };
  if (catConfig) return { model: catConfig.defaultModel, modelSource: 'member_config' as const };
  return { model: '', modelSource: 'unresolved' as const };
}

/** Frozen inherited effort, or the provider's default when the member was not registered. */
export function inheritedEffortFor(selection: FrozenRuntimeSelection, provider: ClientId): string {
  return selection.inheritedEffort ?? getCatEffort(selection.catId, undefined, provider);
}

/**
 * Must run synchronously next to the catConfig read it is paired with: no
 * await between them, so no config write can interleave.
 */
export function freezeRuntimeSelection(catId: string, catConfig: CatConfig | undefined): FrozenRuntimeSelection {
  const nativeTool = catConfig?.configurationSource === 'native_tool';
  const { model, modelSource } = resolveModel(catId, catConfig, nativeTool);
  const savedEffort = catConfig?.cli?.effort?.trim() || undefined;
  // Without a member snapshot there is nothing to freeze: consumers apply their
  // own provider-aware default through inheritedEffortFor().
  const inheritedEffort = !catConfig
    ? null
    : nativeTool
      ? (savedEffort ?? '')
      : getCatEffort(catId, undefined, catConfig.clientId);
  return Object.freeze({
    catId,
    configurationSource: catConfig?.configurationSource,
    nativeTool,
    nativeAuthentication: usesNativeToolConfiguration(catConfig),
    model,
    modelSource,
    inheritedEffort,
    effortSource: savedEffort ? 'member_config' : nativeTool ? 'native_inherit' : 'client_default',
    savedModel: catConfig?.defaultModel?.trim() || undefined,
    savedEffort,
  });
}
