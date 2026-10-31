export type TextAggregationMode = 'append' | 'replace';

export function accumulateTextAggregate(current: string, next: string, mode: TextAggregationMode | undefined): string {
  return mode === 'replace' ? next : current + next;
}

export function accumulateTextParts(current: string[], next: string, mode: TextAggregationMode | undefined): string[] {
  if (mode === 'replace') {
    current.splice(0, current.length, next);
    return current;
  }
  current.push(next);
  return current;
}

export function flattenTextParts(parts: readonly string[]): string {
  return parts.join('');
}

export function flattenTurnTextParts(turns: ReadonlyArray<{ textParts: readonly string[] }>): string {
  return turns.map((turn) => flattenTextParts(turn.textParts)).join('');
}
