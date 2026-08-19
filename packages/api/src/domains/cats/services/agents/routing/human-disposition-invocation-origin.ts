export const HUMAN_DISPOSITION_INVOCATION_ORIGINS = [
  'direct_owner',
  'queue_replay',
  'a2a',
  'callback',
  'connector',
  'system',
  'unknown',
] as const;

export type HumanDispositionInvocationOrigin = (typeof HUMAN_DISPOSITION_INVOCATION_ORIGINS)[number];

export function isDirectOwnerDispositionOrigin(
  origin: HumanDispositionInvocationOrigin | undefined,
): origin is 'direct_owner' {
  return origin === 'direct_owner';
}
