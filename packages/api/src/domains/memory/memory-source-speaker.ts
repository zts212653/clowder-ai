import { catRegistry } from '@cat-cafe/shared';
import { type MessageFromSource, messageFrom } from '../cats/services/stores/message-from.js';
/** Call only after the original message passed the lane's owner/visibility checks. */
export function memorySourceSpeaker(message: MessageFromSource): string {
  const from = messageFrom(message);
  if (from.kind === 'user') return '你';
  if (from.kind === 'agent') {
    const cat = catRegistry.tryGet(from.catId)?.config;
    return cat?.nickname || cat?.displayName || '猫';
  }
  return from.kind === 'system' ? '系统' : '外部来源';
}
