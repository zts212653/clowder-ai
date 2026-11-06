import type { DesktopWindowContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import {
  validateCompanionCommand as validateDeskCommand,
  validateCompanionReply as validateDeskReply,
} from '@clowder-ai/plugin-contract-033c0';
import { validateCompanionCommand as validateLegacyCommand } from '@clowder-ai/plugin-contract-beta21';
import { validateCompanionCommand as validateModernCommand } from '@clowder-ai/plugin-contract-beta23';
import { validateCompanionCommand as validateUnifiedCommand } from '@clowder-ai/plugin-contract-beta24';
import { validateCompanionCommand as validateWorkCommand } from '@clowder-ai/plugin-contract-beta25';
import { validateCompanionCommand as validatePresentationCommand } from '@clowder-ai/plugin-contract-beta27';
import { validateCompanionCommand as validateLetterCommand } from '@clowder-ai/plugin-contract-beta28';
import {
  validateCompanionCommand as validateAppAssistCommand,
  validateCompanionReply as validateAppAssistReply,
} from '@clowder-ai/plugin-contract-beta29';
import type { CompanionContract } from './published-companion-v2.js';

// The trusted CJS desktop kernel imports this compiled ESM Host boundary. Package
// resolution stays in the API installation and uses the contract's import export.
export { validateCompanionCommand } from '@clowder-ai/plugin-contract-beta21';

// The kernel reads capabilities from the same table the Host admitted the archive with.
export { companionContractHas } from './published-companion-v2.js';

/** One public command schema per admitted contract line. */
const COMMAND_VALIDATORS: Record<CompanionContract, (value: unknown) => boolean> = {
  '0.1.0-beta.21': validateLegacyCommand,
  '0.1.0-beta.23': validateModernCommand,
  '0.1.0-beta.24': validateUnifiedCommand,
  '0.1.0-beta.25': validateWorkCommand,
  '0.1.0-beta.27': validatePresentationCommand,
  '0.1.0-beta.28': validateLetterCommand,
  '0.1.0-beta.29': validateAppAssistCommand,
  '0.3.3-candidate.0': validateDeskCommand,
};

/** The complete reply the desktop session assembles (base + `appAssist`, and `desk` from 0.3.3). */
const FULL_REPLY_VALIDATORS: Partial<Record<CompanionContract, (value: unknown) => boolean>> = {
  '0.1.0-beta.29': validateAppAssistReply,
  '0.3.3-candidate.0': validateDeskReply,
};

export function companionCommandValidator(contract: CompanionContract = '0.1.0-beta.21') {
  const validator = COMMAND_VALIDATORS[contract];
  if (!validator) throw new Error('Unsupported companion contract');
  return validator;
}

export function appAssistReplyValidator(contract: CompanionContract) {
  const validator = FULL_REPLY_VALIDATORS[contract];
  if (!validator) throw new Error('Unsupported app-assist contract');
  return validator;
}

/** This Host consumer admits one declarative companion body. Package code never
 * runs in the Host or Electron main process; media is separately user-admitted.
 */
export function desktopWindowContribution(manifest: PluginManifest): DesktopWindowContribution | undefined {
  const contributions = manifest.contributions ?? [];
  const feature = manifest.features[0];
  const contribution = contributions[0];
  if (
    manifest.runtime?.transport !== 'builtin' ||
    manifest.runtime.entrypoint !== undefined ||
    (manifest.configuration?.length ?? 0) !== 0 ||
    (manifest.data?.length ?? 0) !== 0 ||
    manifest.signals !== undefined ||
    contributions.length !== 1 ||
    contribution?.type !== 'desktop-window' ||
    manifest.features.length !== 1 ||
    !feature ||
    feature.resources.length !== 0 ||
    feature.contributions?.length !== 1 ||
    feature.contributions[0].type !== contribution.type ||
    feature.contributions[0].id !== contribution.id
  )
    return undefined;
  return contribution;
}
