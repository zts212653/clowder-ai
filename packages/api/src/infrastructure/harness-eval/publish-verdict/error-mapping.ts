import type { HandlerError } from './types.js';

export function mapPublishVerdictError(message: string): HandlerError | null {
  if (message.startsWith('invalid_analysis_findings')) {
    return { status: 400, error: 'invalid_analysis_findings', detail: message };
  }
  if (message.startsWith('measurement_validity_gate')) {
    return { status: 409, error: 'measurement_validity_gate', detail: message };
  }
  if (message.startsWith('verdict_already_exists_on_main')) {
    return { status: 409, error: 'verdict_already_exists', detail: message };
  }
  if (message.startsWith('artifact_already_exists') || message.startsWith('verdict_id_taken')) {
    return { status: 409, error: 'verdict_already_exists', detail: message };
  }
  if (message.startsWith('verdict_window_already_published')) {
    return { status: 409, error: 'verdict_window_already_published', detail: message };
  }
  if (message.startsWith('verdict_window_duplicated_in_candidate')) {
    return { status: 409, error: 'verdict_window_duplicated_in_candidate', detail: message };
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

const GENERATED_ARTIFACT_CONTRACT_ERRORS = ['artifact_coordinate_mismatch', 'artifact_not_materialized'];

/**
 * Classify a failed publication. A generator whose report does not match what it
 * wrote has failed, even when the publisher is the one that notices.
 */
export function classifyPublishFailure(message: string, generatorReturned: boolean): HandlerError {
  const mapped = mapPublishVerdictError(message);
  if (mapped) return mapped;
  if (!generatorReturned || GENERATED_ARTIFACT_CONTRACT_ERRORS.some((prefix) => message.startsWith(prefix))) {
    return { status: 500, error: 'generator_failed', detail: message };
  }
  return { status: 500, error: 'publisher_failed', detail: message };
}
