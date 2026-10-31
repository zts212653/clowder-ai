import type { AnchorPreviewEvent } from './anchor-event-log.js';

export interface AnchorAdoptionRollup {
  explicitAnchorCalls: number;
  explicitFullCalls: number;
  defaultAnchorCalls: number;
  defaultFullCalls: number;
  legacyEquivalentAnchorCalls: number;
  legacyEquivalentFullCalls: number;
  uniqueCatsExplicitAnchor: number;
  unknownModeCalls: number;
}

type AnchorAdoptionCounterKey = keyof Omit<AnchorAdoptionRollup, 'uniqueCatsExplicitAnchor'>;

const ADOPTION_COUNTER_BY_MODE: Record<string, AnchorAdoptionCounterKey> = {
  'explicit:anchor': 'explicitAnchorCalls',
  'explicit:full': 'explicitFullCalls',
  'default:anchor': 'defaultAnchorCalls',
  'default:full': 'defaultFullCalls',
  'legacy_equivalent:anchor': 'legacyEquivalentAnchorCalls',
  'legacy_equivalent:full': 'legacyEquivalentFullCalls',
};

export function summarizeAdoption(events: AnchorPreviewEvent[]): AnchorAdoptionRollup {
  const adoption: Omit<AnchorAdoptionRollup, 'uniqueCatsExplicitAnchor'> = {
    explicitAnchorCalls: 0,
    explicitFullCalls: 0,
    defaultAnchorCalls: 0,
    defaultFullCalls: 0,
    legacyEquivalentAnchorCalls: 0,
    legacyEquivalentFullCalls: 0,
    unknownModeCalls: 0,
  };
  const explicitAnchorCats = new Set<string>();

  for (const event of events) {
    const counterKey = ADOPTION_COUNTER_BY_MODE[`${event.modeSource}:${event.modeResolved}`];
    if (counterKey) {
      adoption[counterKey]++;
      if (counterKey === 'explicitAnchorCalls' && event.catId) explicitAnchorCats.add(event.catId);
      continue;
    }

    adoption.unknownModeCalls++;
  }

  return {
    ...adoption,
    uniqueCatsExplicitAnchor: explicitAnchorCats.size,
  };
}
