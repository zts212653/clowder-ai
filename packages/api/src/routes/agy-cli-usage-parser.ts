import type { CodexUsageItem } from './quota.js';

const MIN_VALID_RESET_TIME_MS = Date.UTC(2000, 0, 1);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function classifyAgyPool(groupName: string, bucketId: string): { poolId: string; labelPrefix: string } {
  if (bucketId.startsWith('gemini-') || /\bgemini\b/i.test(groupName)) {
    return { poolId: 'agy-gemini', labelPrefix: 'Gemini · ' };
  }
  if (bucketId.startsWith('3p-') || /\b(?:claude|gpt)\b/i.test(groupName)) {
    return { poolId: 'agy-claude-gpt', labelPrefix: 'Claude / GPT · ' };
  }
  const cleanGroup = groupName.trim() || 'AGY';
  return { poolId: 'agy-other', labelPrefix: `${cleanGroup} · ` };
}

function normalizeWindowBaseLabel(windowCode: string, bucketName: string): string {
  if (windowCode === 'weekly' || /\bweekly\b/i.test(bucketName)) {
    return '每周使用限额';
  }
  const hoursMatch = /^(\d+)\s*h$/i.exec(windowCode.trim());
  if (hoursMatch?.[1]) {
    return `${hoursMatch[1]}小时使用限额`;
  }
  if (/\bfive\s+hour\b/i.test(bucketName)) {
    return '5小时使用限额';
  }
  return bucketName.trim() || '使用限额';
}

function normalizeUpstreamResetIso(rawResetTime: unknown): string | undefined {
  if (typeof rawResetTime !== 'string') return undefined;
  const trimmed = rawResetTime.trim();
  if (!trimmed) return undefined;
  const parsedMs = Date.parse(trimmed);
  // Reject malformed strings and Go zero time ("0001-01-01T00:00:00Z"); never fabricate a window duration.
  if (!Number.isFinite(parsedMs) || parsedMs < MIN_VALID_RESET_TIME_MS) return undefined;
  return trimmed;
}

function extractCommandGroups(commandOwner: Record<string, unknown>): unknown[] | null {
  if (typeof commandOwner.status === 'string' && commandOwner.status !== 'SUCCESS') return null;
  const command = asRecord(commandOwner.command);
  if (command?.name !== 'usage') return null;
  const data = asRecord(command.data);
  return Array.isArray(data?.groups) ? data.groups : null;
}

function extractUsageGroupsPayload(record: Record<string, unknown>): unknown[] | null {
  const direct = extractCommandGroups(record);
  if (direct) return direct;
  const result = asRecord(record.result);
  return result ? extractCommandGroups(result) : null;
}

function parseGroupsFromNdjson(trimmed: string): unknown[] | null {
  let groups: unknown[] | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    try {
      const parsedLine = asRecord(JSON.parse(clean));
      const candidate = parsedLine ? extractUsageGroupsPayload(parsedLine) : null;
      if (candidate) groups = candidate;
    } catch {
      // Ignore non-JSON preamble lines when mixed.
    }
  }
  return groups;
}

function parseGroupsFromRawText(trimmed: string): unknown[] | null {
  try {
    const parsed = asRecord(JSON.parse(trimmed));
    return parsed ? extractUsageGroupsPayload(parsed) : null;
  } catch {
    return parseGroupsFromNdjson(trimmed);
  }
}

function parseSingleBucketItem(groupName: string, rawBucket: unknown): CodexUsageItem | null {
  const bucket = asRecord(rawBucket);
  if (!bucket || bucket.disabled === true) return null;
  const fraction = bucket.remaining_fraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    return null;
  }
  const bucketId = typeof bucket.id === 'string' ? bucket.id : '';
  const bucketName = typeof bucket.name === 'string' ? bucket.name : '';
  const windowCode = typeof bucket.window === 'string' ? bucket.window : '';
  const { poolId, labelPrefix } = classifyAgyPool(groupName, bucketId);
  const baseLabel = normalizeWindowBaseLabel(windowCode, bucketName);
  const remainingPercent = Math.round(Math.max(0, Math.min(1, fraction)) * 10_000) / 100;
  const resetsAt = normalizeUpstreamResetIso(bucket.reset_time);

  return {
    label: `${labelPrefix}${baseLabel}`,
    usedPercent: remainingPercent,
    percentKind: 'remaining',
    poolId,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Parse official `agy --output-format json -p /usage` (or stream-json) output
 * into pool-separated quota items (`agy-gemini` vs `agy-claude-gpt`).
 */
export function parseAgyCliUsageOutput(raw: string): CodexUsageItem[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const groups = parseGroupsFromRawText(raw.trim());
  if (!groups?.length) return [];

  const items: CodexUsageItem[] = [];
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group || !Array.isArray(group.buckets)) continue;
    const groupName = typeof group.name === 'string' ? group.name : '';
    for (const rawBucket of group.buckets) {
      const item = parseSingleBucketItem(groupName, rawBucket);
      if (item) items.push(item);
    }
  }
  return items;
}
