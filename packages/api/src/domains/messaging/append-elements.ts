import type { AppendElementsRequest, EpistemicStatus, MessageElement } from '@clowder-ai/plugin-contract';
import { MessagingError } from './contract/host-types.js';
import type { PluginMessageExtra } from './envelope.js';

function statusOf(element: MessageElement, plugin: PluginMessageExtra): EpistemicStatus {
  return element.epistemicStatus ?? plugin.provenance.epistemicStatus;
}

/** INV-7: stamp appended elements; reject elevation and underivated non-inference claims. */
export function stampAppendedElements(
  parsed: AppendElementsRequest,
  plugin: PluginMessageExtra,
  existingIds: ReadonlySet<string>,
): MessageElement[] {
  const stamped: MessageElement[] = [];
  for (const element of parsed.elements) {
    if (existingIds.has(element.elementId)) {
      throw new MessagingError('VALIDATION', `elementId "${element.elementId}" already exists (INV-6: no rewrite)`);
    }
    let source: MessageElement | undefined;
    if (element.derivedFromElementId !== undefined) {
      source = plugin.elements.find((el) => el.elementId === element.derivedFromElementId);
      if (!source) {
        throw new MessagingError(
          'VALIDATION',
          `derivedFromElementId "${element.derivedFromElementId}" does not reference a persisted element`,
        );
      }
    }
    const claimed = element.epistemicStatus ?? 'inference';
    if (claimed !== 'inference' && (!source || statusOf(source, plugin) !== claimed)) {
      throw new MessagingError(
        'VALIDATION',
        'appended element claims a non-inference status without an equal-status derivation source (INV-7)',
      );
    }
    stamped.push({ ...element, epistemicStatus: claimed });
  }
  return stamped;
}

export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function payloadBytes(elements: readonly MessageElement[]): number {
  return elements.reduce((total, element) => total + Buffer.byteLength(JSON.stringify(element.payload), 'utf8'), 0);
}
