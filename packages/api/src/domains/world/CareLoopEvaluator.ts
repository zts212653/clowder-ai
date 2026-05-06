import type { CareLoopHint, CharacterRecord, WorldEventEntry } from '@cat-cafe/shared';

export interface CareLoopConfig {
  minEventsBetweenChecks: number;
  triggerKeywords: string[];
}

const DEFAULT_CONFIG: CareLoopConfig = {
  minEventsBetweenChecks: 8,
  triggerKeywords: ['lonely', 'sad', 'frustrated', 'tired', 'overwhelmed', '孤独', '难过', '累', '焦虑', '沮丧'],
};

export class CareLoopEvaluator {
  private readonly config: CareLoopConfig;

  constructor(config?: Partial<CareLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(recentEvents: WorldEventEntry[], characters: CharacterRecord[]): CareLoopHint | undefined {
    let lastCareIndex = -1;
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      if (recentEvents[i].type === 'care_check_in') {
        lastCareIndex = i;
        break;
      }
    }
    const eventsSinceLastCare = lastCareIndex === -1 ? recentEvents.length : recentEvents.length - 1 - lastCareIndex;

    if (eventsSinceLastCare < this.config.minEventsBetweenChecks) return undefined;

    const trigger = this.detectTrigger(recentEvents.slice(lastCareIndex + 1), characters);
    if (!trigger) return undefined;

    return {
      trigger: trigger.reason,
      suggestion: trigger.suggestion,
      realityBridge: trigger.bridge,
    };
  }

  private detectTrigger(
    events: WorldEventEntry[],
    characters: CharacterRecord[],
  ): { reason: string; suggestion: string; bridge: string } | undefined {
    for (const event of events.reverse()) {
      const payloadStr = JSON.stringify(event.payload).toLowerCase();
      for (const kw of this.config.triggerKeywords) {
        if (payloadStr.includes(kw.toLowerCase())) {
          const char = characters.find((c) => c.characterId === event.characterId);
          const name = char?.coreIdentity?.name ?? event.characterId ?? 'character';
          return {
            reason: `${name} expressed "${kw}" in recent scene`,
            suggestion: `Check in with the user — ${name}'s emotional state may mirror something real`,
            bridge: `You've been exploring some heavy themes with ${name}. How are you feeling about this?`,
          };
        }
      }
    }
    return undefined;
  }
}
