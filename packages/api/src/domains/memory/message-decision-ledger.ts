import type { MessageSearchResult } from '@cat-cafe/shared';

export type DecisionSourceFact = NonNullable<MessageSearchResult['decisionSources']>[number];
export interface DecisionSourceRecord {
  threadId: string;
  messageId: string;
  fact: DecisionSourceFact;
}
export const decisionSourceKey = (ref: { threadId: string; messageId: string }) => `${ref.threadId}:${ref.messageId}`;
const sourcePattern = /(thread_[A-Za-z0-9_]+|…)#(\d{13,17}-\d{6}-[a-f0-9]{8})\b/g;
const statuses = new Map<string, DecisionSourceFact['status']>([
  ['已定', 'decided'],
  ['提议 · 没采用', 'not-adopted'],
  ['未采用', 'not-adopted'],
  ['已定（再确认）', 'decided'],
  ['后来改了', 'superseded'],
  ['被取代', 'superseded'],
]);
function plain(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`]/g, '')
    .trim();
}
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** A whole date field is metadata; dates embedded in a narrative are not. */
function declaredDate(cell: string): string | undefined {
  const value = plain(cell);
  return /^(?:\d{4}-)?(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?(?: (?:PDT|PST|UTC))?$/.test(
    value,
  )
    ? value
    : undefined;
}

type SourceRole = DecisionSourceFact['status'];
interface SourceCoordinate {
  threadId: string;
  messageId: string;
  status: SourceRole;
}

function declaredRole(raw: string): SourceRole | 'inherit' | undefined {
  const prefix = plain(raw).replace(/^[、，,\s]+|[：:\s]+$/g, '');
  if (!prefix) return 'inherit';
  const marked = [...raw.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => statuses.get(match[1].trim()))
    .filter(Boolean)
    .at(-1);
  return marked ?? statuses.get(prefix);
}
function segmentSources(segment: string, initial: SourceRole, sharedThread?: string): SourceCoordinate[] {
  const sources: SourceCoordinate[] = [];
  let end = 0;
  let status = initial;
  for (const match of segment.matchAll(sourcePattern)) {
    const role = declaredRole(segment.slice(end, match.index));
    end = match.index + match[0].length;
    if (!role) continue; // Narrative "起因" is not a declaration.
    if (role !== 'inherit') status = role;
    const threadId = match[1] === '…' ? sharedThread : match[1];
    if (threadId) sources.push({ threadId, messageId: match[2], status });
  }
  return sources;
}
function cellSources(cell: string, status: SourceRole): SourceCoordinate[] {
  const declared = new Set(
    [...cell.matchAll(/\b(thread_[A-Za-z0-9_]+)#\d{13,17}-\d{6}-[a-f0-9]{8}/g)].map((match) => match[1]),
  );
  const shared = declared.size === 1 ? [...declared][0] : undefined;
  return cell.split(/；|;|<br\s*\/?\s*>/iu).flatMap((segment) => segmentSources(segment, status, shared));
}
function tableRow(
  row: string[],
  header: string[],
  document: Pick<DecisionSourceFact, 'documentPath' | 'documentRevision' | 'featureId' | 'line'>,
): DecisionSourceRecord[] {
  if (row.length !== header.length || row.every((cell) => /^:?-+:?$/.test(cell))) return [];
  const decision = header.findIndex((cell) => /^(决定|已定事项|结论|事项)$/.test(cell));
  const source = header.findIndex((cell) => /^(出处|来源)$/.test(cell));
  if (decision < 0 || source < 0) return [];
  const statusColumn = header.findIndex((cell) => /^(状态|处置)$/.test(cell));
  const status = statusColumn < 0 ? 'decided' : statuses.get(plain(row[statusColumn]));
  const conclusion = plain(row[decision]).slice(0, 600);
  if (!status || !conclusion) return [];
  const at = header.findIndex((cell) => /^(?:决定时间|决定日期|日期|时间)(?:[（(][^）)]*[）)])?$/.test(cell));
  const by = header.findIndex((cell) => /^(谁定的|决定人|谁)$/.test(cell));
  const decidedBy = by >= 0 ? plain(row[by]).slice(0, 80) : undefined;
  const decidedAt = at >= 0 ? declaredDate(row[at]) : undefined;
  const fact = {
    ...document,
    conclusion,
    ...(decidedBy ? { decidedBy } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(status !== 'decided' ? { historical: true } : {}),
  };
  return cellSources(row[source], status).map(({ threadId, messageId, status: role }) => ({
    threadId,
    messageId,
    fact: { ...fact, status: role },
  }));
}

/** Only a declared decision table and its exact source cells convey status.
 * A shorthand thread is valid only when that same cell declares exactly one full thread. */
export function parseDecisionLedger(
  text: string,
  documentPath: string,
  documentRevision: string,
): DecisionSourceRecord[] {
  const featureId = /(?:^|\/)(F\d{3})[^/]*\.md$/.exec(documentPath)?.[1];
  if (!featureId) return [];
  const records: DecisionSourceRecord[] = [];
  let active = false;
  let header: string[] | undefined;
  let fence: string | undefined;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      header = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+)/.exec(lines[i]);
    if (heading) {
      active = /^已定(?:事项)?(?:\s|[（(:：]|$)/u.test(heading[2]);
      header = undefined;
      continue;
    }
    if (!active || !lines[i].startsWith('|')) {
      header = undefined;
      continue;
    }
    const row = cells(lines[i]);
    if (lines[i + 1]?.match(/^\|\s*:?-{3}/)) {
      header = row.map(plain);
      continue;
    }
    if (header) records.push(...tableRow(row, header, { documentPath, documentRevision, featureId, line: i + 1 }));
  }
  return records;
}
