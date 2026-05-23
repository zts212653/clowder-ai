'use client';

import type { MarketplaceSearchResult } from '@cat-cafe/shared';
import { EcosystemBadge, TrustBadge } from './marketplace-badges';

export function ArtifactCard({
  result,
  onSelect,
}: {
  result: MarketplaceSearchResult;
  onSelect: (r: MarketplaceSearchResult) => void;
}) {
  return (
    <button
      onClick={() => onSelect(result)}
      className="w-full rounded-xl bg-[var(--console-card-bg)] p-4 text-left shadow-[0_8px_22px_rgba(43,33,26,0.04)] transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-cafe">{result.displayName}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <EcosystemBadge ecosystem={result.ecosystem} />
          <TrustBadge level={result.trustLevel} />
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-cafe-secondary">{result.componentSummary}</p>

      <div className="mt-2 flex items-center justify-between text-micro text-cafe-muted">
        <span>{result.sourceLocator}</span>
        {result.publisherIdentity && <span>{result.publisherIdentity}</span>}
      </div>
    </button>
  );
}
