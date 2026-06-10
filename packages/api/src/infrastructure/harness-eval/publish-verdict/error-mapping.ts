import type { HandlerError } from './types.js';

export function mapPublishVerdictError(message: string): HandlerError | null {
  if (message.startsWith('verdict_already_exists_on_main')) {
    return { status: 409, error: 'verdict_already_exists', detail: message };
  }
  if (message.startsWith('invalid_source_ref')) {
    return { status: 400, error: 'invalid_source_ref', detail: message };
  }
  if (message.startsWith('evidence_not_found')) {
    return { status: 404, error: 'evidence_not_found', detail: message };
  }
  if (message.startsWith('session_not_found')) {
    return { status: 404, error: 'session_not_found', detail: message };
  }
  if (message.startsWith('owner_user_required')) {
    return { status: 401, error: 'unauthenticated', detail: message };
  }
  if (message.startsWith('no_trials_in_window')) {
    return { status: 404, error: 'no_trials_in_window', detail: message };
  }
  if (message.startsWith('no_metrics_in_window')) {
    return { status: 404, error: 'no_metrics_in_window', detail: message };
  }
  if (message.startsWith('invalid_packet_field')) {
    return { status: 400, error: 'invalid_packet_field', detail: message };
  }
  if (message.startsWith('invalid_episode_verdict_writeback')) {
    return { status: 400, error: 'invalid_episode_verdict_writeback', detail: message };
  }
  if (message.startsWith('handoff_incomplete')) {
    return { status: 400, error: 'handoff_incomplete', detail: message };
  }
  return null;
}
