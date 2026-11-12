import { catRegistry } from '@cat-cafe/shared';
import { sliceUnicodeSafe } from '../../utils/unicode-safe-slice.js';
import type { HostPluginConfigurationService } from '../plugin/manager/plugin-manager-configuration.js';

export const COMPANION_PLUGIN_ID = 'official.companion';

/** 猫猫球's owner settings: official.companion's plugin configuration, defaults from its manifest. */
export interface CompanionSettings {
  enabled: boolean;
  dutyCatProfileId: string;
  displayName: string;
  personaTone: string;
  proactivePolicy: 'ambient' | 'quiet-badge';
  behaviorEnabled: boolean;
  skin: 'yarn-ball' | 'ragdoll-v1' | 'yanyan-codex' | 'xianxian-codex';
  ballSize: number;
}

export type ReadCompanionSettings = () => Promise<CompanionSettings>;

/** A member field declares no default; until one is chosen the companion is answered by the roster default. */
function defaultMember(): string {
  const ids = catRegistry.getAllIds();
  if (ids.includes('gemini35' as never)) return 'gemini35';
  return ids[0] ?? 'sonnet';
}

/** Name and persona tone go into a member's prompt: one line, bounded (50 / 200, as the manifest describes). */
function line(value: string, max: number): string {
  return sliceUnicodeSafe(value.replace(/\s*[\r\n]+\s*/g, ' ').trim(), 0, max);
}

export async function readCompanionSettings(
  configuration: Pick<HostPluginConfigurationService, 'readActionInput'>,
): Promise<CompanionSettings> {
  const values = (await configuration.readActionInput(COMPANION_PLUGIN_ID)) as Record<string, string>;
  return {
    enabled: values.enabled === 'true',
    dutyCatProfileId: values.dutyCatProfileId ?? defaultMember(),
    displayName: line(values.displayName, 50),
    personaTone: line(values.personaTone, 200),
    proactivePolicy: values.proactivePolicy as CompanionSettings['proactivePolicy'],
    behaviorEnabled: values.behaviorEnabled === 'true',
    skin: values.skin as CompanionSettings['skin'],
    ballSize: Math.min(192, Math.max(43, Number(values.ballSize))),
  };
}
