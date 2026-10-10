import type { MessageMetadata, TimeoutDiagnostics } from '../../types.js';

const OPTIONAL_STRING_FIELDS = ['lastEventType', 'cliSessionId', 'invocationId', 'rawArchivePath'] as const;
const OPTIONAL_NUMBER_FIELDS = ['firstEventAt', 'lastEventAt'] as const;

/**
 * Reduce a provider's `timeout_diagnostics` system_info payload to the fields the diagnostics
 * panel renders. Anything else the provider attached (terminal context, excerpts) is not
 * persisted. A payload without its two required facts is not diagnostics.
 */
export function timeoutDiagnosticsFromSystemInfo(parsed: Record<string, unknown>): TimeoutDiagnostics | undefined {
  if (parsed.type !== 'timeout_diagnostics') return undefined;
  if (typeof parsed.silenceDurationMs !== 'number' || typeof parsed.processAlive !== 'boolean') return undefined;
  const diagnostics: TimeoutDiagnostics = {
    silenceDurationMs: parsed.silenceDurationMs,
    processAlive: parsed.processAlive,
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = parsed[field];
    if (typeof value === 'string' && value) diagnostics[field] = value;
  }
  for (const field of OPTIONAL_NUMBER_FIELDS) {
    const value = parsed[field];
    if (typeof value === 'number' && Number.isFinite(value)) diagnostics[field] = value;
  }
  return diagnostics;
}

/**
 * F118 AC-C3 / F117: timeout diagnostics explain why the turn's response failed, so they fold
 * into the metadata persisted with that response (the latest one wins — it explains the failure
 * that ended the turn). Provider/model placeholders are filled by the provider's own snapshot.
 */
export function withTimeoutDiagnostics(
  metadata: MessageMetadata | undefined,
  parsed: Record<string, unknown>,
): MessageMetadata | undefined {
  const timeoutDiagnostics = timeoutDiagnosticsFromSystemInfo(parsed);
  if (!timeoutDiagnostics) return metadata;
  return { ...(metadata ?? { provider: '', model: '' }), timeoutDiagnostics };
}
