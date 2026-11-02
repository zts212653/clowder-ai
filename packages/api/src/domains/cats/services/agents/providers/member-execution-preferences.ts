import { type CatConfig, normalizeCliEffortForProvider } from '@cat-cafe/shared';
import { usesNativeToolConfiguration } from '../../../../../config/cat-account-binding.js';
import { getCatModel } from '../../../../../config/cat-models.js';

/** Admission-owned choices. Empty native preferences preserve the CLI's own defaults. */
export function captureMemberExecutionPreferences(catId: string, config: CatConfig, model?: string) {
  return Object.freeze({
    configurationSource: config.configurationSource,
    model:
      model ??
      (config.configurationSource === 'native_tool' ? config.defaultModel : getCatModel(catId, config.defaultModel)),
    effort:
      config.cli?.effort?.trim() ||
      (config.configurationSource === 'native_tool'
        ? ''
        : (normalizeCliEffortForProvider(config.clientId, undefined) ?? 'high')),
    nativeAuthentication: usesNativeToolConfiguration(config),
  });
}

export type MemberExecutionPreferences = ReturnType<typeof captureMemberExecutionPreferences>;
