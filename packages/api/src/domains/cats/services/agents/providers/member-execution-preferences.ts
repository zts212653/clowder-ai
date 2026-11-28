import { type CatConfig, inferGoogleModelEffort, normalizeCliEffortForProvider } from '@cat-cafe/shared';
import { usesNativeToolConfiguration } from '../../../../../config/cat-account-binding.js';
import { getCatModel } from '../../../../../config/cat-models.js';

/** Admission-owned choices. Empty native preferences preserve the CLI's own defaults. */
export function captureMemberExecutionPreferences(catId: string, config: CatConfig, model?: string) {
  const resolvedModel =
    model ??
    (config.configurationSource === 'native_tool' ? config.defaultModel : getCatModel(catId, config.defaultModel));
  const explicitEffort = config.cli?.effort?.trim();
  const isGoogle = config.clientId === 'google' || config.clientId === 'antigravity';
  return Object.freeze({
    configurationSource: config.configurationSource,
    model: resolvedModel,
    effort:
      explicitEffort ||
      (config.configurationSource === 'native_tool'
        ? ''
        : ((isGoogle ? inferGoogleModelEffort(resolvedModel) : null) ??
          normalizeCliEffortForProvider(config.clientId, undefined) ??
          'high')),
    ...(config.clientId === 'kimi' || isGoogle
      ? { effortSource: explicitEffort ? ('member' as const) : ('platform_default' as const) }
      : {}),
    nativeAuthentication: usesNativeToolConfiguration(config),
  });
}

export type MemberExecutionPreferences = ReturnType<typeof captureMemberExecutionPreferences>;
