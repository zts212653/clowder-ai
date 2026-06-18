'use client';

import type { BacklogItem, CatId } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { adaptTeamHomeData } from './adapter';
import { ActiveMissionsTable } from './blocks/ActiveMissionsTable';
import { BatonBoard } from './blocks/BatonBoard';
import { CultureConstitutionPanel } from './blocks/CultureConstitutionPanel';
import { CVODecisionQueue } from './blocks/CVODecisionQueue';
import { QualityGateChecklist } from './blocks/QualityGateChecklist';
import { RecentMemoryFeed } from './blocks/RecentMemoryFeed';
import { RiskWatch } from './blocks/RiskWatch';
import { SharedMissionBanner } from './blocks/SharedMissionBanner';
import { TeamStatusCards } from './blocks/TeamStatusCards';

interface TeamHomePanelProps {
  items: BacklogItem[];
  threadsByBacklogId?: Record<string, { lastActiveAt: number; participants: CatId[] }>;
}

export function TeamHomePanel({ items, threadsByBacklogId }: TeamHomePanelProps) {
  const data = useMemo(() => adaptTeamHomeData({ items, threadsByBacklogId }), [items, threadsByBacklogId]);

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        <SharedMissionBanner mission={data.mission} />
        <BatonBoard baton={data.baton} />
        <div className="grid gap-4 md:grid-cols-2">
          <QualityGateChecklist gates={data.qualityGates} />
          <TeamStatusCards members={data.team} />
        </div>
        <ActiveMissionsTable missions={data.missions} />
        <CultureConstitutionPanel culture={data.culture} />
      </div>
      <aside className="w-full shrink-0 space-y-4 lg:w-80">
        <CVODecisionQueue items={data.cvoDecisions} />
        <RiskWatch risks={data.risks} />
        <RecentMemoryFeed items={data.recentMemory} />
      </aside>
    </div>
  );
}
