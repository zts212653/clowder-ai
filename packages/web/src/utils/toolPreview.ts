import { extractAppendedRecallMetaBlock, stripAppendedRecallMetaBlock } from '@cat-cafe/shared';

export function extractRecallMetaDetail(raw: string): string | undefined {
  return extractAppendedRecallMetaBlock(raw);
}

export function toolResultDetail(raw: string): string {
  const trimmed = stripAppendedRecallMetaBlock(raw).trimEnd();
  if (trimmed.length === 0) return '(no output)';
  return trimmed;
}
