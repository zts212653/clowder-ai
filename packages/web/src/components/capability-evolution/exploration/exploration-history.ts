import type { EvolutionExplorationNodeV1 } from '@cat-cafe/shared';
export function isHistoricalStep(node: EvolutionExplorationNodeV1 | undefined): node is Extract<
  EvolutionExplorationNodeV1,
  { kind: 'public_archive' }
> & {
  history: NonNullable<Extract<EvolutionExplorationNodeV1, { kind: 'public_archive' }>['history']>;
} {
  return node?.kind === 'public_archive' && node.history !== undefined;
}
