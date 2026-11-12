import { catRegistry } from '@cat-cafe/shared';
import { isCatAvailable } from '../../config/cat-config-loader.js';
import { sliceUnicodeSafe } from '../../utils/unicode-safe-slice.js';
import type { HostPluginConfigurationService } from '../plugin/manager/plugin-manager-configuration.js';
import { liveSelectable } from './live/live-companion-selection.js';

export const COMPANION_PLUGIN_ID = 'official.companion';

/** 猫猫球's owner settings: official.companion's plugin configuration, defaults from its manifest. */
export interface CompanionSettings {
  dutyCatProfileId: string;
  displayName: string;
  personaTone: string;
  proactivePolicy: 'ambient' | 'quiet-badge';
  behaviorEnabled: boolean;
  skin: 'yarn-ball' | 'ragdoll-v1' | 'yanyan-codex' | 'xianxian-codex';
  ballSize: number;
}

export type ReadCompanionSettings = () => Promise<CompanionSettings>;

/** A member field declares no default; until a current member is chosen, the first available member the
 * companion's live selection accepts answers (the same rule the settings view offers members by). */
function defaultMember(): string {
  const cats = Object.values(catRegistry.getAllConfigs()).filter((cat) => isCatAvailable(cat.id));
  return (cats.find((cat) => liveSelectable(cat.id, cats)) ?? cats[0])?.id ?? '';
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
    dutyCatProfileId: catRegistry.has(values.dutyCatProfileId) ? values.dutyCatProfileId : defaultMember(),
    displayName: line(values.displayName, 50),
    personaTone: line(values.personaTone, 200),
    proactivePolicy: values.proactivePolicy as CompanionSettings['proactivePolicy'],
    behaviorEnabled: values.behaviorEnabled === 'true',
    skin: values.skin as CompanionSettings['skin'],
    ballSize: Math.min(192, Math.max(43, Number(values.ballSize))),
  };
}
