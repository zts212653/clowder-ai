'use client';

import type { MarketplaceSearchResult } from '@cat-cafe/shared';
import { ExpandableProse } from '@/components/content-overflow';
import { isRowPrimaryActionTarget } from '@/utils/row-primary-action';
import { EcosystemBadge, TrustBadge } from './marketplace-badges';

export function ArtifactCard({
  result,
  onSelect,
}: {
  result: MarketplaceSearchResult;
  onSelect: (r: MarketplaceSearchResult) => void;
}) {
  const selectArtifact = () => onSelect(result);
  return (
    // biome-ignore lint/a11y: the nested native button owns keyboard/screen-reader semantics; the article restores the surrounding pointer hit area
    <article
      onClick={(event) => {
        if (isRowPrimaryActionTarget(event.target, event.currentTarget)) selectArtifact();
      }}
      className="w-full cursor-pointer rounded-xl bg-[var(--console-card-bg)] p-4 text-left shadow-[0_8px_22px_rgba(43,33,26,0.04)] transition-shadow hover:shadow-md"
    >
      <button type="button" onClick={selectArtifact} className="w-full text-left">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-cafe">{result.displayName}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <EcosystemBadge ecosystem={result.ecosystem} />
            <TrustBadge level={result.trustLevel} />
          </div>
        </div>
        <span className="mt-1 inline-block text-micro font-semibold text-cafe-accent">查看详情</span>
      </button>

      <ExpandableProse
        text={result.componentSummary}
        lines={2}
        className="mt-1.5"
        contentClassName="text-xs leading-relaxed text-cafe-secondary"
      />

      <div className="mt-2 flex items-center justify-between text-micro text-cafe-muted">
        <span>{result.sourceLocator}</span>
        {result.publisherIdentity && <span>{result.publisherIdentity}</span>}
      </div>
    </article>
  );
}
