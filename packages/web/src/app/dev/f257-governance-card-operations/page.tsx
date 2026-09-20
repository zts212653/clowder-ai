'use client';

/**
 * F257 governance — action/diff fixtures.
 *
 * Why this page exists (operator 2026-09-10): four review rounds on #171 found
 * seven approval-fact defects in the action-diff dialog, and none of them could
 * be seen by any cat. The existing showcase (`/showcase/f257-governance-journey`)
 * builds an ApprovalHubItem whose `detail` carries no `changes` at all, so
 * F257GovernanceChanges renders "本卡没有可执行动作" — the dialog was never on
 * screen. Real cards only appear after a real governance cycle, so the defects
 * were only reachable after merge.
 *
 * Scope (narrowed after sol's review of 09ffa8bd9): this renders
 * F257GovernanceChanges directly rather than a whole ApprovalHubItem. The first
 * two attempts wrapped the changes in a synthetic full proposal, which dragged
 * in objective provenance, canonical labels/statements and an evaluation-model
 * metric set — none of it under test here, and all of it impossible to keep
 * faithful without duplicating the registry. Every finding so far landed on
 * that wrapper, never on the diff. A fixture should be exactly as wide as the
 * thing it verifies, so the only data below is HarnessGovernanceProposalChange
 * values, typed against production and guarded by the source-backed contract
 * test next to this file.
 */

import { useState } from 'react';
import { F257GovernanceChanges } from '@/components/F257GovernanceChanges';
import { SettingsText } from '@/components/settings/primitives';
import { SCENARIOS } from './fixtures';

export default function F257GovernanceCardOperationsFixtures() {
  const [openId, setOpenId] = useState<string>(SCENARIOS[0].id);
  const active = SCENARIOS.find((scenario) => scenario.id === openId) ?? SCENARIOS[0];

  return (
    <main className="mx-auto min-h-dvh max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <SettingsText as="h1" variant="base" className="font-bold">
          F257 治理 · 动作与差异 fixtures
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="muted">
          构造数据而不是等真实周期。这里只渲染动作列表与差异弹窗本身，不伪装成完整审批卡——
          周期头部、指标与结论不在本页验证范围内，也无法在不复制 registry 的前提下保持忠实。
        </SettingsText>
      </header>

      <nav className="flex flex-wrap gap-2" data-testid="f257-fixture-tabs">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            onClick={() => setOpenId(scenario.id)}
            aria-pressed={openId === scenario.id}
            data-testid={`f257-fixture-tab-${scenario.id}`}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              openId === scenario.id
                ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]'
                : 'border border-cafe text-cafe-secondary hover:bg-cafe-surface'
            }`}
          >
            {scenario.title}
          </button>
        ))}
      </nav>

      <section className="space-y-3" data-testid={`f257-fixture-${active.id}`}>
        <SettingsText as="p" variant="xs" tone="muted">
          预期：{active.hint}
        </SettingsText>
        <div className="rounded-2xl border border-cafe bg-[var(--console-card-bg)] p-4 text-sm">
          <F257GovernanceChanges changes={[active.change]} />
        </div>
      </section>
    </main>
  );
}
