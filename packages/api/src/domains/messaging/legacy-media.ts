import type { MessageElement } from '@clowder-ai/plugin-contract';

/** Old connector platform keys are locators, not Host media objects. Never persist or publish them. */
export function replaceLegacyMediaReferences(elements: readonly MessageElement[]): readonly MessageElement[] {
  return elements.map((element) => {
    if (element.kind !== 'media_ref') return element;
    const { reference, type, fileName } = element.payload;
    if (reference.startsWith('hmr_') || reference.startsWith('pmr_')) return element;
    console.warn('[messaging] legacy media reference unavailable', { elementId: element.elementId });
    return {
      ...element,
      kind: 'media_unavailable' as const,
      payload: { type, ...(fileName === undefined ? {} : { fileName }), reason: 'unavailable' as const },
    };
  });
}
