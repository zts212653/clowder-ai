import { isValidRichBlock, normalizeRichBlock, type RichBlock } from '@cat-cafe/shared';
import type { StoredMessage } from './ports/MessageStore.js';

type MessageExtra = NonNullable<StoredMessage['extra']>;

/**
 * A plugin message keeps its rich blocks as `rich_block` elements of `extra.pluginMessage`, the
 * plugin's canonical payload. Readers find them where every other message keeps its blocks:
 * `extra.rich`, derived here when a message is read and never stored. The elements decide for a
 * plugin message, so a stored `extra.rich` on one is replaced. Blocks go through the same
 * normalization and validation as member blocks; invalid ones are dropped, in element order.
 */
export function withPluginMessageRich<E extends MessageExtra | undefined>(extra: E): E {
  const elements = extra?.pluginMessage?.elements;
  if (!extra || !Array.isArray(elements)) return extra;
  const blocks = elements.flatMap((element): RichBlock[] => {
    if (element.kind !== 'rich_block') return [];
    const block = normalizeRichBlock(structuredClone(element.payload));
    return isValidRichBlock(block) ? [block] : [];
  });
  const { rich: _stored, ...rest } = extra;
  return (blocks.length > 0 ? { ...rest, rich: { v: 1, blocks } } : rest) as E;
}
