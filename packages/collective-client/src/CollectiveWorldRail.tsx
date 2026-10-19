import { MeowClubMark, WorldRailFrame } from '@cat-cafe/ui';
import type { CollectiveMembership } from './client-types.js';

export function CollectiveWorldRail({
  activeCollective,
  collectives,
  onHome,
  onSelectCollective,
  visible,
}: {
  readonly activeCollective?: CollectiveMembership;
  readonly collectives?: readonly CollectiveMembership[];
  readonly onHome?: () => void;
  readonly onSelectCollective?: (collectiveId: string) => void;
  readonly visible: boolean;
}) {
  if (!visible || !collectives?.length) return null;
  return (
    <WorldRailFrame className="global-rail" data-spatial-role="global-rail" aria-label="选择共同家园">
      <div className="brand-mark" role="img" aria-label="Clowder AI Collective">
        <MeowClubMark />
      </div>
      <nav>
        {collectives.map((item) => {
          const active = item.collectiveId === activeCollective?.collectiveId;
          return (
            <button
              key={item.collectiveId}
              type="button"
              className={`rail-button ${active ? 'rail-button-active' : ''}`}
              aria-label={item.name}
              aria-current={active ? 'page' : undefined}
              onClick={() => (active ? onHome?.() : onSelectCollective?.(item.collectiveId))}
            >
              <span className="world-mark">{item.name.slice(0, 1)}</span>
              <span>{item.name}</span>
            </button>
          );
        })}
      </nav>
    </WorldRailFrame>
  );
}
