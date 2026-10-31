/** One worktree-local, atomically written owner retention fact; never a second Task owner. */
export const MAX_RETENTION_MS = 30 * 86_400_000;

export function retentionStatus(lifecycle, now = Date.now()) {
  const r = lifecycle?.retention;
  if (r === undefined) return null;
  const text = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= 2000 && !/[\r\n\0]/.test(s);
  const date = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
  if (
    !r ||
    typeof r !== 'object' ||
    r.owner !== lifecycle.owner ||
    !text(r.reason) ||
    !text(r.sourceRef) ||
    !text(r.head) ||
    !date(r.until) ||
    !date(r.recordedAt) ||
    Date.parse(r.until) - Date.parse(r.recordedAt) > MAX_RETENTION_MS
  ) {
    return 'retention-invalid';
  }
  return now < Date.parse(r.until) ? 'retained-until' : 'retention-expired';
}

export function capacityRetention(lifecycle, head) {
  const status = retentionStatus(lifecycle);
  if (!status) return {};
  if (status === 'retention-invalid') return { retentionStatus: status };
  return {
    retentionStatus: head === lifecycle.retention.head ? status : 'retention-head-changed',
    retainedUntil: lifecycle.retention.until,
  };
}

export function retentionMessages(holders) {
  return holders
    .filter((h) => h.retentionStatus)
    .map(
      (h) => `[worktree-reaper] ${h.retentionStatus} ${h.name} owner=${h.owner} until=${h.retainedUntil ?? 'unknown'}`,
    );
}
