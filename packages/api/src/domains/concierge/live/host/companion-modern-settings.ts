import { CONCIERGE_CONFIG_DEFAULTS, clampBallSize } from '@cat-cafe/shared';
import { type CompanionCommand, type CompanionReply, validateCompanionReply } from '@clowder-ai/plugin-contract-beta23';
import { z } from 'zod';
import type { CompanionOwnerClient } from '../companion-owner-client.js';

const unavailable = () => ({ kind: 'settings', status: 'unavailable', reason: 'temporarily_unavailable' }) as const;
type Update = Extract<CompanionCommand, { kind: 'settings.update' }>;
const settledCall = z.enum(['unchanged', 'stopped']);

/** Read the same owner record, applying only its canonical legacy defaults. */
export async function readModernCompanionSettings(client: CompanionOwnerClient): Promise<CompanionReply> {
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
  const config: Record<string, unknown> = { ...CONCIERGE_CONFIG_DEFAULTS, ...parsed.data };
  const size = config.ballSize;
  if (size != null && typeof size !== 'number') return unavailable();
  const candidate = {
    kind: 'settings',
    status: 'available',
    values: {
      dutyCatProfileId: config.dutyCatProfileId,
      skin: config.skin,
      ballSize: clampBallSize(size),
      behaviorEnabled: config.behaviorEnabled ?? true,
      proactivePolicy: config.proactivePolicy,
      personaTone: config.personaTone,
      householdReadsAllowed: config.householdReadsAllowed ?? true,
    },
    companions: response.body.companions,
    selectedCompanionStatus: response.body.selectedCompanionStatus,
  };
  return validateCompanionReply(candidate) ? candidate : unavailable();
}

export async function updateModernCompanionSettings(
  client: CompanionOwnerClient,
  command: Update,
  stopped: () => void,
): Promise<CompanionReply> {
  if (command.field === 'dutyCatProfileId') {
    const read = await readModernCompanionSettings(client);
    if (read.kind !== 'settings' || read.status !== 'available')
      return {
        kind: 'settings-update',
        field: command.field,
        outcome: 'rejected',
        callStatus: 'unchanged',
        reason: read.kind === 'error' && read.code === 'permission_required' ? 'permission_denied' : 'save_failed',
      };
    if (!read.companions.some((cat) => cat.catProfileId === command.value && cat.available))
      return {
        kind: 'settings-update',
        field: command.field,
        outcome: 'rejected',
        callStatus: 'unchanged',
        reason: 'selection_unavailable',
      };
  }
  const { statusCode, body } = await client.requestResponse('/api/concierge/config', 'PUT', {
    [command.field]: command.value,
  });
  const rejected = (reason: 'invalid_value' | 'permission_denied' | 'unsupported') =>
    ({ kind: 'settings-update', field: command.field, outcome: 'rejected', callStatus: 'unchanged', reason }) as const;
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
    applies: command.field === 'personaTone' ? 'next_call' : 'now',
  };
}
