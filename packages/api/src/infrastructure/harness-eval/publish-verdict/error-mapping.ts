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
  if (
    message.startsWith('unknown assessment trial:') ||
    message.startsWith('foreign assessment evidence ref:') ||
    message.startsWith('foreign first meaningful event ref:') ||
    message.startsWith('first meaningful event evidence ref is required:') ||
    message.startsWith('first meaningful event must belong to the target opening invocation:') ||
    message.startsWith('semantic assessment requires available transcript evidence:') ||
    message.startsWith('semantic assessment requires a target transcript evidence ref:') ||
    message.startsWith('duplicate_session_recovery_trial:') ||
    message.startsWith('missing_session_recovery_assessment:') ||
    message.startsWith('session_recovery_assessment_mismatch:')
  ) {
    return { status: 400, error: 'invalid_assessment', detail: message };
  }
  if (message.startsWith('session_scan_limit_reached:')) {
    return { status: 400, error: 'window_too_broad', detail: message };
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
