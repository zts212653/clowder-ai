import { readFileSync } from 'node:fs';

/** Linux birth evidence is boot-relative; wall-clock adjustments cannot change it. */
export function readProcBirth(pid) {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return undefined;
    // After comm: state is field 3, so starttime (field 22) is [19].
    const fields = stat
      .slice(closingParen + 2)
      .trim()
      .split(/\s+/);
    const procStartTicks = Number(fields[19]);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!Number.isSafeInteger(procStartTicks) || procStartTicks < 0 || !bootId) return undefined;
    return { procStartTicks, bootId };
  } catch {
    return undefined;
  }
}

/** Partial markers cannot prove the same incarnation across boots. */
export function compareStableBirth(stored, identity) {
  if (
    !Number.isSafeInteger(stored?.procStartTicks) ||
    stored.procStartTicks < 0 ||
    !Number.isSafeInteger(identity?.procStartTicks) ||
    identity.procStartTicks < 0
  )
    return undefined;
  if (stored.procStartTicks !== identity.procStartTicks) return false;
  const storedBootId = typeof stored.bootId === 'string' ? stored.bootId.trim() : '';
  const currentBootId = typeof identity.bootId === 'string' ? identity.bootId.trim() : '';
  if (!storedBootId || !currentBootId) return undefined;
  return storedBootId === currentBootId;
}
