'use client';

import { useEffect } from 'react';
import type { EvalHubItem } from '../../../components/HubEvalTypes';
import { HubEvalVerdictCard } from '../../../components/HubEvalVerdictCard';
import { TrajectoryPanel } from '../../../components/workspace/trajectory/TrajectoryPanel';
import { useChatStore } from '../../../stores/chatStore';

const verdict: EvalHubItem = {
  id: 'verdict-f299-phase-c-preview',
  domainId: 'eval:capability-wakeup',
  packetId: 'packet-f299-phase-c-preview',
  feedbackType: 'live-verdict',
  verdict: 'fix',
  phenomenon: 'A single invocation needs canonical evidence.',
  operatorNarrative: {
    headline: 'F299 Phase C evidence dogfood',
    summary: '从 verdict 的 inv 锚点进入 canonical invocation，再返回这张卡。',
    action: '逐个验证可用、拒绝与缺失状态。',
    nextCheck: '返回后焦点必须落回当前 verdict。',
    evidenceQuality: 'usable',
  },
  ownerAsk: 'Verify canonical invocation evidence navigation.',
  harnessUnderEval: { featureId: 'F299', componentId: 'phase-c', name: 'Canonical invocation evidence' },
  reeval: { status: 'pending_owner', summary: 'browser contract', nextEvalAt: '2026-08-23T00:00:00.000Z' },
  lifecycle: {
    availability: 'available',
    ownerResponseStatus: 'not_started',
    closureStatus: 'open',
    reevalStatus: 'not_requested',
    stale: false,
  },
  evidence: {
    snapshotRefs: ['snapshot:phase-c-preview'],
    attributionRefs: [],
    metricRefs: ['metric:native-ref'],
    otherRefs: ['inv:inv-cross', 'inv:inv-forbidden', 'inv:inv-missing', 'trace:trace-native'],
  },
  trend: { generatedAt: '2026-08-22T00:00:00.000Z', window: { durationHours: 24 }, components: [] },
  systemWorkspace: {
    kind: 'eval_domain',
    id: 'eval:capability-wakeup',
    label: 'Capability Wakeup Eval',
    threadId: 'thread-eval-capability-wakeup',
    stateSot: 'registry',
  },
  source: { verdictPath: 'verdict.md', bundleDir: 'bundle' },
};

export function F299PhaseCEvidencePreview() {
  useEffect(() => {
    const store = useChatStore.getState();
    store.setCurrentThread('thread-origin');
    store.setWorkspaceMode('eval');
  }, []);

  return (
    <main className="grid min-h-screen gap-4 bg-cafe-surface-canvas p-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
      <section className="min-h-0 overflow-y-auto" data-trajectory-origin-scroll>
        <HubEvalVerdictCard item={verdict} />
      </section>
      <section className="h-[760px] min-h-0 overflow-hidden rounded-2xl border border-cafe bg-cafe-surface">
        <TrajectoryPanel />
      </section>
    </main>
  );
}
