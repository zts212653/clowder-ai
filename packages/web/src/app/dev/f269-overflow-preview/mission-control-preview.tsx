'use client';

import type { BacklogItem, CatId } from '@cat-cafe/shared';
import { FeatureBirdEyePanel } from '@/components/mission-control/FeatureBirdEyePanel';
import { FeatureRowList } from '@/components/mission-control/FeatureRowList';

const FEATURE_NAME = 'Mission Control Feature Name With A Canonical Tail 必须在窄屏、键盘和触屏上完整恢复';
const THREAD_TITLE = 'F269 linked implementation thread with a long diagnostic title and canonical-tail-linked';
const NOW = 1_754_915_200_000;

const ITEM: BacklogItem = {
  id: 'f269-mission-control-preview',
  userId: 'default-user',
  title: `[F269] ${FEATURE_NAME}`,
  summary: 'Mission Control compact-label production preview',
  priority: 'p1',
  tags: ['feature:f269'],
  status: 'dispatched',
  createdBy: 'user',
  createdAt: NOW,
  updatedAt: NOW,
  dispatchedAt: NOW,
  dispatchedThreadId: 'thread-f269-mission-control-preview',
  dispatchedThreadPhase: 'coding',
  audit: [],
};

const THREAD = {
  id: 'thread-f269-mission-control-preview',
  title: THREAD_TITLE,
  lastActiveAt: NOW,
  participants: ['codex-sol'] as CatId[],
  backlogItemId: ITEM.id,
};

export function MissionControlRecoveryPreview() {
  const threadsByBacklogId = { [ITEM.id]: THREAD };

  return (
    <section
      data-testid="f269-mission-control-recovery"
      className="rounded-3xl border border-cafe bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow-soft)] sm:p-7"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-cafe-accent">
        Production spot-check · Mission Control
      </p>
      <h2 className="mt-2 text-lg font-bold text-cafe">整行主操作不缩水，全文恢复不嵌套</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-cafe-secondary">
        默认没有额外按钮；名称真实溢出后才出现复制入口。恢复入口与整行展开、线程导航是 sibling，不会误触主操作。
      </p>

      <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="min-w-0">
          <p className="mb-2 text-micro font-bold uppercase tracking-[0.1em] text-cafe-muted">Bird-eye</p>
          <FeatureBirdEyePanel
            items={[ITEM]}
            threadsByBacklogId={threadsByBacklogId}
            threadCountByFeature={{ F269: 1 }}
          />
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-micro font-bold uppercase tracking-[0.1em] text-cafe-muted">Feature row</p>
          <FeatureRowList
            items={[ITEM]}
            threadsByBacklogId={threadsByBacklogId}
            threadCountByFeature={{ F269: 1 }}
            selectedItemId={null}
            onSelectItem={() => {}}
          />
        </div>
      </div>
    </section>
  );
}
