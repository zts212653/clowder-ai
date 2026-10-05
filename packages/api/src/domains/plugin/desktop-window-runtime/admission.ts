import type { DesktopWindowContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import { validateCompanionCommand as validateLegacyCommand } from '@clowder-ai/plugin-contract';
import { validateCompanionCommand as validateModernCommand } from '@clowder-ai/plugin-contract-beta23';
import { validateCompanionCommand as validateUnifiedCommand } from '@clowder-ai/plugin-contract-beta24';
import type { CompanionArchiveContract } from './published-companion-v2.js';

// The trusted CJS desktop kernel imports this compiled ESM Host boundary. Package
// resolution stays in the API installation and uses the contract's import export.
export { validateCompanionCommand } from '@clowder-ai/plugin-contract';

export function companionCommandValidator(contract: CompanionArchiveContract['contract'] = '0.1.0-beta.21') {
  if (contract === '0.1.0-beta.21') return validateLegacyCommand;
  if (contract === '0.1.0-beta.23') return validateModernCommand;
  if (contract === '0.1.0-beta.24') return validateUnifiedCommand;
  throw new Error('Unsupported companion contract');
}

/** This Host consumer admits one declarative companion body. Package code never
 * runs in the Host or Electron main process; media is separately user-admitted.
 */
export function desktopWindowContribution(manifest: PluginManifest): DesktopWindowContribution | undefined {
  const contributions = manifest.contributions ?? [];
  const feature = manifest.features[0];
  const contribution = contributions[0];
  if (
    manifest.runtime.transport !== 'builtin' ||
    manifest.runtime.entrypoint !== undefined ||
    (manifest.configuration?.length ?? 0) !== 0 ||
    (manifest.data?.length ?? 0) !== 0 ||
    manifest.signals !== undefined ||
    contributions.length !== 1 ||
    contribution?.type !== 'desktop-window' ||
    manifest.features.length !== 1 ||
    !feature ||
    feature.resources.length !== 0 ||
    feature.capabilities.length !== 1 ||
    feature.capabilities[0] !== 'windows.create' ||
    feature.contributions?.length !== 1 ||
    feature.contributions[0].type !== contribution.type ||
    feature.contributions[0].id !== contribution.id
  )
    return undefined;
  return contribution;
}
