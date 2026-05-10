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
      type="button"
      onClick={() => onSelect(result)}
      className="w-full console-list-card rounded-xl p-4 text-left shadow-[0_4px_16px_rgba(43,33,26,0.06)] transition-shadow hover:shadow-[0_6px_20px_rgba(43,33,26,0.1)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-cafe">{result.displayName}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <EcosystemBadge ecosystem={result.ecosystem} />
          <TrustBadge level={result.trustLevel} />
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-cafe-secondary">{result.componentSummary}</p>

      <div className="mt-2 flex items-center justify-between text-[10px] text-cafe-muted">
        <span className="font-mono">{result.sourceLocator}</span>
        {result.publisherIdentity && <span>{result.publisherIdentity}</span>}
      </div>
    </button>
  );
}
