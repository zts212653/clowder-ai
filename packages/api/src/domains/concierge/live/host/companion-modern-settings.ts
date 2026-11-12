import { clampBallSize } from '@cat-cafe/shared';
import { validateCompanionReply as validateDeskReply } from '@clowder-ai/plugin-contract-033c0';
import { type CompanionCommand, validateCompanionReply } from '@clowder-ai/plugin-contract-beta23';
import { validateCompanionReply as validateWorkReply } from '@clowder-ai/plugin-contract-beta25';
import { validateCompanionReply as validatePresentationReply } from '@clowder-ai/plugin-contract-beta27';
import { validateCompanionReply as validateLetterReply } from '@clowder-ai/plugin-contract-beta28';
import {
  type CompanionCommand as AppAssistCommand,
  validateCompanionReply as validateAppAssistReply,
} from '@clowder-ai/plugin-contract-beta29';
import { z } from 'zod';
import type { HostCompanionReply } from '../../../plugin/desktop-window-runtime/companion-private-wire.js';
import {
  type CompanionArchiveContract,
  type CompanionContract,
  companionContractHas,
} from '../../../plugin/desktop-window-runtime/published-companion-v2.js';
import { COMPANION_PLUGIN_ID } from '../../companion-settings.js';
import type { CompanionOwnerClient } from '../companion-owner-client.js';

const unavailable = () => ({ kind: 'settings', status: 'unavailable', reason: 'temporarily_unavailable' }) as const;
type Update = Extract<CompanionCommand | AppAssistCommand, { kind: 'settings.update' }>;
const settledCall = z.enum(['unchanged', 'stopped']);
// Published beta.23/24 archives reject smaller replies. Keep the saved owner
// preference intact, but project a value their public contract can consume.
const publishedModernBallSizeMin = 48;
/** The settings reply schema of each line that changed it; earlier modern lines read beta.23's. */
const SETTINGS_REPLIES: Partial<Record<CompanionContract, (value: unknown) => value is HostCompanionReply>> = {
  '0.1.0-beta.25': validateWorkReply,
  '0.1.0-beta.27': validatePresentationReply,
  '0.1.0-beta.28': validateLetterReply,
  '0.1.0-beta.29': validateAppAssistReply,
  '0.3.3-candidate.0': validateDeskReply,
};

function publishedBallSize(size: number | null | undefined, contract: CompanionArchiveContract['contract']) {
  const clamped = clampBallSize(size);
  return companionContractHas(contract, 'smallBall') ? clamped : Math.max(publishedModernBallSizeMin, clamped);
}

/** Read the companion's plugin configuration and the owner's runtime choices. */
export async function readModernCompanionSettings(
  client: CompanionOwnerClient,
  contract: CompanionArchiveContract['contract'] = '0.1.0-beta.23',
): Promise<HostCompanionReply> {
  const response = await client.requestResponse('/api/concierge/config?view=settings');
  if (response.statusCode === 401 || response.statusCode === 403) return { kind: 'error', code: 'permission_required' };
  if (response.statusCode !== 200 || response.body.status !== 'available')
    return {
      kind: 'settings',
      status: 'unavailable',
      reason: response.body.reason === 'host_upgrade_required' ? 'host_upgrade_required' : 'temporarily_unavailable',
    };
  const parsed = z.record(z.unknown()).safeParse(response.body.config);
  if (!parsed.success) return unavailable();
  const config = parsed.data;
  const size = config.ballSize;
  if (typeof size !== 'number') return unavailable();
  const candidate = {
    kind: 'settings',
    status: 'available',
    values: {
      dutyCatProfileId: config.dutyCatProfileId,
      skin: config.skin,
      ballSize: publishedBallSize(size, contract),
      behaviorEnabled: config.behaviorEnabled,
      proactivePolicy: config.proactivePolicy,
      personaTone: config.personaTone,
      householdReadsAllowed: config.householdReadsAllowed ?? true,
      ...(companionContractHas(contract, 'appAssist') ? { appAssistEnabled: config.appAssistEnabled === true } : {}),
    },
    companions: response.body.companions,
    selectedCompanionStatus: response.body.selectedCompanionStatus,
  };
  return (SETTINGS_REPLIES[contract] ?? validateCompanionReply)(candidate) ? candidate : unavailable();
}

const pluginPath = `/api/plugin-manager/plugins/${COMPANION_PLUGIN_ID}`;
const pluginDetail = z.object({
  plugin: z.object({ lifecycleRevision: z.number(), configFields: z.array(z.object({ key: z.string() })) }),
});

export async function updateModernCompanionSettings(
  client: CompanionOwnerClient,
  command: Update,
  stopped: () => void,
): Promise<HostCompanionReply> {
  const rejected = (reason: 'invalid_value' | 'permission_denied' | 'unsupported' | 'save_failed') =>
    ({ kind: 'settings-update', field: command.field, outcome: 'rejected', callStatus: 'unchanged', reason }) as const;
  const detail = await client.requestResponse(pluginPath);
  if (detail.statusCode === 401 || detail.statusCode === 403) return rejected('permission_denied');
  const plugin = pluginDetail.safeParse(detail.body);
  if (detail.statusCode !== 200 || !plugin.success) return rejected('save_failed');
  // The companion's own settings are its plugin configuration: the config page's save validates and restarts it.
  if (plugin.data.plugin.configFields.some((field) => field.key === command.field)) {
    const saved = await client.requestResponse(`${pluginPath}/contributions/configuration`, 'POST', {
      expectedRevision: plugin.data.plugin.lifecycleRevision,
      updates: [{ key: command.field, value: String(command.value) }],
    });
    if (saved.statusCode === 400) return rejected('invalid_value');
    if (saved.statusCode === 401 || saved.statusCode === 403) return rejected('permission_denied');
    if (saved.statusCode === 409) return { kind: 'error', code: 'busy' };
    if (saved.statusCode < 200 || saved.statusCode >= 300) return rejected('save_failed');
    return {
      kind: 'settings-update',
      field: command.field,
      outcome: 'saved',
      callStatus: 'unchanged',
      applies: command.field === 'personaTone' ? 'next_call' : 'now',
    };
  }
  const { statusCode, body } = await client.requestResponse('/api/concierge/config', 'PUT', {
    [command.field]: command.value,
  });
  if (statusCode === 400) return rejected('invalid_value');
  if (statusCode === 401 || statusCode === 403) return rejected('permission_denied');
  if (statusCode === 404) return rejected('unsupported');
  if (body.code === 'config_change_in_progress') return { kind: 'error', code: 'busy' };
  if (body.code === 'live_teardown_unconfirmed' && body.callStatus === 'stop_failed')
    return {
      kind: 'settings-update',
      field: command.field,
      outcome: 'rejected',
      callStatus: 'stop_failed',
      reason: 'call_stop_failed',
    };
  const call = settledCall.safeParse(body.callStatus);
  if (!call.success) return { kind: 'error', code: 'unavailable' };
  if (call.data === 'stopped') stopped();
  if (body.code === 'configuration_write_unconfirmed')
    return {
      kind: 'settings-update',
      field: command.field,
      outcome: 'unconfirmed',
      callStatus: call.data,
      reconcile: 'settings.read',
    };
  if (statusCode < 200 || statusCode >= 300)
    return {
      kind: 'settings-update',
      field: command.field,
      outcome: 'rejected',
      callStatus: call.data,
      reason: 'save_failed',
    };
  return {
    kind: 'settings-update',
    field: command.field,
    outcome: 'saved',
    callStatus: call.data,
    applies: 'now',
  };
}
