import { presentationLedgerScopeKey } from '../../session/ledger-key.js';

export const PresentationLedgerKeys = {
  /**
   * One hash per `scopeKey × contextEpoch` generation; one field per projection.
   *
   * Grouping by generation (rather than one flat key per projection) is what
   * makes a superseded epoch's entries enumerable later — a flat keyspace would
   * only be walkable by `SCAN`-ing the whole prefix.
   */
  generation: (encodedScopeKey: string) => `presentation-ledger:gen:${encodedScopeKey}`,
  /** Exact generation key derived from the epoch owner's raw scope + epoch. */
  generationForScope: (scopeKey: string, contextEpoch: number) =>
    `presentation-ledger:gen:${presentationLedgerScopeKey({ scopeKey, contextEpoch })}`,
} as const;
