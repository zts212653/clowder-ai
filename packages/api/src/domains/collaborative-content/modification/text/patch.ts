import type { RespondContentText } from '@cat-cafe/shared';
import { ModificationTextError } from './errors.js';

export function applyContentTextEdits(text: string, edits: RespondContentText['edits']): string {
  let cursor = 0,
    result = '';
  for (const [index, edit] of edits.entries()) {
    if (
      edit.start < cursor ||
      edit.end > text.length ||
      text.slice(edit.start, edit.end) !== edit.expectedText ||
      (index > 0 && edit.start === edits[index - 1]?.start)
    )
      throw new ModificationTextError('invalid_patch');
    result += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  result += text.slice(cursor);
  if (
    Buffer.byteLength(result) > 1024 * 1024 ||
    result.includes('\0') ||
    Buffer.from(result).toString('utf8') !== result
  )
    throw new ModificationTextError('invalid_patch');
  return result;
}
