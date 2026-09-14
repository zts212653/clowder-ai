import type { AssemblerInput, HookCondition } from '@cat-cafe/shared';

const ROUTING_MODES = new Set(['independent', 'serial', 'parallel']);
const MAX_COLLECTION_SIZE = 64;

/** Fail-closed validation for the governance condition catalogue. */
export function isHookCondition(value: unknown): value is HookCondition {
  if (!isRecord(value) || !isRecord(value.params) || typeof value.conditionRef !== 'string') return false;
  const params = value.params;
  switch (value.conditionRef) {
    case 'routing-mode-in':
      return (
        hasOnlyKeys(params, ['values']) &&
        Array.isArray(params.values) &&
        params.values.length > 0 &&
        params.values.length <= 3 &&
        new Set(params.values).size === params.values.length &&
        params.values.every((mode) => typeof mode === 'string' && ROUTING_MODES.has(mode))
      );
    case 'prompt-tag-present':
      return hasOnlyKeys(params, ['value']) && isBoundedString(params.value);
    case 'minimum-teammates':
    case 'minimum-active-participants':
      return hasOnlyKeys(params, ['count']) && isBoundedCount(params.count);
    case 'voice-mode-is':
    case 'mcp-available-is':
    case 'a2a-enabled-is':
    case 'direct-message-is':
      return hasOnlyKeys(params, ['value']) && typeof params.value === 'boolean';
    default:
      return false;
  }
}

/** Conditions are an extra AND gate after the built-in resolver, so they can only narrow injection. */
export function matchesHookCondition(condition: HookCondition, input: AssemblerInput): boolean {
  switch (condition.conditionRef) {
    case 'routing-mode-in':
      return condition.params.values.includes(input.mode);
    case 'prompt-tag-present':
      return input.promptTags.includes(condition.params.value);
    case 'minimum-teammates':
      return input.teammates.length >= condition.params.count;
    case 'minimum-active-participants':
      return input.activeParticipants.length >= condition.params.count;
    case 'voice-mode-is':
      return input.voiceMode === condition.params.value;
    case 'mcp-available-is':
      return input.mcpAvailable === condition.params.value;
    case 'a2a-enabled-is':
      return input.a2aEnabled === condition.params.value;
    case 'direct-message-is':
      return (input.directMessage !== null) === condition.params.value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COLLECTION_SIZE;
}
