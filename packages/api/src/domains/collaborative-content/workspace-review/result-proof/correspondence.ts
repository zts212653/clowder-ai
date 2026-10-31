import { isDeepStrictEqual } from 'node:util';

export type ProjectReviewInterval = { startTick: number; endTick: number };
export type ProjectReviewUsage = ProjectReviewInterval & {
  key: string;
  position: string;
  assetVersionRef?: string;
  content: unknown;
};
export type ProjectReviewEvidence = { value: unknown; usages: ProjectReviewUsage[] };
type IdentityInput = { key: string; value: unknown };

/** Detect preserved inputs with reassigned IDs; insertion/deletion and real input edits remain legal. */
export function unchangedIdentityPermutation(before: IdentityInput[], after: IdentityInput[], key: string): boolean {
  const oldByKey = new Map(before.map((item) => [item.key, item]));
  const newByKey = new Map(after.map((item) => [item.key, item]));
  if (!oldByKey.has(key) || !newByKey.has(key) || isDeepStrictEqual(oldByKey.get(key)?.value, newByKey.get(key)?.value))
    return false;
  const commonBefore = before.filter((item) => newByKey.has(item.key));
  const commonAfter = after.filter((item) => oldByKey.has(item.key));
  if (
    isDeepStrictEqual(
      commonBefore.map((item) => item.value),
      commonAfter.map((item) => item.value),
    )
  )
    return true;
  return hasPreservedCycle(commonBefore, commonAfter, key, newByKey);
}

function hasPreservedCycle(
  before: IdentityInput[],
  after: IdentityInput[],
  key: string,
  newByKey: Map<string, IdentityInput>,
): boolean {
  const byInput = semanticSources(before);
  const queue = [key];
  const visited = new Set(queue);
  const predecessor = new Map<string, string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    for (const previous of byInput.get(signature(newByKey.get(current)?.value)) ?? []) {
      if (previous === key && current !== key && cycleInputsUnchanged(before, after, key, current, predecessor))
        return true;
      if (!visited.has(previous)) {
        visited.add(previous);
        predecessor.set(previous, current);
        queue.push(previous);
      }
    }
  }
  return false;
}

function semanticSources(items: IdentityInput[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const encoded = signature(item.value);
    const keys = groups.get(encoded);
    if (keys) keys.push(item.key);
    else groups.set(encoded, [item.key]);
  }
  return groups;
}

function cycleInputsUnchanged(
  before: IdentityInput[],
  after: IdentityInput[],
  key: string,
  current: string,
  predecessor: Map<string, string>,
): boolean {
  const members = new Set([key]);
  let cursor: string | undefined = current;
  while (cursor && cursor !== key) {
    members.add(cursor);
    cursor = predecessor.get(cursor);
  }
  return isDeepStrictEqual(
    before.filter((item) => members.has(item.key)).map((item) => item.value),
    after.filter((item) => members.has(item.key)).map((item) => item.value),
  );
}

export function materialUseChanged(
  before: ProjectReviewEvidence,
  after: ProjectReviewEvidence,
  use: ProjectReviewUsage,
  boundToUse: boolean,
  targetRanges?: ProjectReviewInterval[],
): boolean {
  const previous = before.usages.find((item) => item.key === use.key);
  if (previous && isDeepStrictEqual(previous.content, use.content)) return false;
  const identity = (items: ProjectReviewUsage[]) => items.map((item) => ({ key: item.key, value: input(item) }));
  if (unchangedIdentityPermutation(identity(before.usages), identity(after.usages), use.key)) return false;
  const ranges = boundToUse ? (previous ? [previous, use] : [use]) : targetRanges;
  const projection = (usages: ProjectReviewUsage[]) =>
    usages.flatMap((item) => {
      if (boundToUse && item.position !== use.position) return [];
      return (ranges ?? [item]).flatMap((range) => {
        const startTick = Math.max(item.startTick, range.startTick);
        const endTick = Math.min(item.endTick, range.endTick);
        return startTick < endTick ? [{ position: item.position, startTick, endTick, content: item.content }] : [];
      });
    });
  // Compare complete inputs inside the target, without a monotonic sibling-material count.
  const beforeInputs = projection(before.usages);
  const afterInputs = projection(after.usages);
  if (isDeepStrictEqual(beforeInputs, afterInputs)) return false;
  if (previous) return true;
  // New IDs prove insertion only when their scoped input multiplicity increases; a rename cannot borrow changes.
  return projection([use]).some(
    (value) => inputMultiplicity(afterInputs, value) > inputMultiplicity(beforeInputs, value),
  );
}

function inputMultiplicity(inputs: ReturnType<typeof input>[], value: ReturnType<typeof input>): number {
  return inputs.filter((item) => isDeepStrictEqual(item, value)).length;
}

function input(item: ProjectReviewUsage) {
  return { position: item.position, startTick: item.startTick, endTick: item.endTick, content: item.content };
}

function signature(value: unknown): string {
  // Ephemeral comparison only; no owner/operation/blob encoding is changed.
  return String(
    JSON.stringify(value, (_key, current: unknown) =>
      current && typeof current === 'object' && !Array.isArray(current)
        ? Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)))
        : current,
    ),
  );
}
