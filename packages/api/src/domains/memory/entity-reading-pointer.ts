import { formatInjectionProvenance, hasInjectionStoryCoordinate } from './injection-provenance.js';
import type { EntityProvenance } from './interfaces.js';

const label = (value: string): string => JSON.stringify(value);

/** Distinguish an authored reading purpose from administrative proposal/birth anchors. */
export function hasAuthoredEntityReadingPointer(pointer: EntityProvenance): boolean {
  return Boolean(
    pointer.note?.trim() &&
      (pointer.sourcePath ||
        (pointer.threadId && (pointer.messageId || pointer.messageIds?.length)) ||
        pointer.sessionId),
  );
}

/** The author supplies purpose; the renderer only pairs it with the same source coordinates. */
export function formatEntityReadingPointer(pointer: EntityProvenance, selfAnchor: string): string | null {
  if (!hasInjectionStoryCoordinate(pointer, selfAnchor)) return null;
  const locations: string[] = [];
  if (pointer.sourcePath) locations.push(`文件 ${label(pointer.sourcePath)}`);
  if (pointer.threadId) locations.push(`对话 ${label(pointer.threadId)}`);
  if (pointer.messageId) locations.push(`原消息 ${label(pointer.messageId)}`);
  if (pointer.messageIds?.length) locations.push(`原消息 ${label(pointer.messageIds.join(', '))}`);
  if (pointer.sessionId) locations.push(`会话 ${label(pointer.sessionId)}`);
  if (pointer.eventNo !== undefined) locations.push(`事件 ${pointer.eventNo}`);
  if (pointer.invocationId) locations.push(`轮次 ${label(pointer.invocationId)}`);
  if (!locations.length && pointer.anchor) locations.push(`原文锚点 ${label(pointer.anchor)}`);
  const purpose = pointer.note?.trim() ? `登记的阅读用途：${label(pointer.note.trim())}；` : '';
  return `${purpose}阅读位置：${locations.join('，')}\n    ${formatInjectionProvenance(pointer)}`;
}
