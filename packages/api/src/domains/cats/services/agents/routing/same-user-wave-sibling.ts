/**
 * A reply that another cat produced from the same user wave this prompt already covers is not
 * new work for this cat: the trigger it answers is already in the prompt, and it was not directed
 * here. Excluding it keeps a parallel wave from folding its own echo back into every sibling.
 */
export interface SameUserWaveSiblingCandidate {
  mentions?: readonly string[];
  extra?: {
    targetCats?: readonly string[];
    causal?: { kind: 'invocation_reply'; triggerMessageId: string };
  };
}

export function isSameUserWaveSiblingReply(
  message: SameUserWaveSiblingCandidate,
  context: { catId: string; coveredTriggerMessageIds?: ReadonlySet<string> },
): boolean {
  const explicitTargets = new Set([...(message.mentions ?? []), ...(message.extra?.targetCats ?? [])]);
  const causal = message.extra?.causal;
  return Boolean(
    causal?.kind === 'invocation_reply' &&
      context.coveredTriggerMessageIds?.has(causal.triggerMessageId) &&
      !explicitTargets.has(context.catId),
  );
}
