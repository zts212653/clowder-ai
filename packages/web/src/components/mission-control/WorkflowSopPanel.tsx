'use client';

import {
  type CheckStatus,
  DEVELOPMENT_SOP_DEFINITION,
  DEVELOPMENT_SOP_STAGE_IDS,
  resolveWorkflowSopSkill,
  type SopStage,
  type WorkflowSop,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface WorkflowSopPanelProps {
  backlogItemId: string | null;
}

const STAGE_LABELS = Object.fromEntries(
  DEVELOPMENT_SOP_DEFINITION.stages.map((stage) => [stage.id, stage.label]),
) as Record<SopStage, string>;

const STAGE_ORDER = [...DEVELOPMENT_SOP_STAGE_IDS] as SopStage[];

const CHECK_LABELS: Record<keyof WorkflowSop['checks'], string> = {
  remoteMainSynced: 'Main 同步',
  qualityGatePassed: '质量门禁',
  reviewApproved: 'Review 放行',
  visionGuardDone: '愿景守护',
};

function CheckBadge({ status }: { status: CheckStatus }) {
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--mc-status-done-bg)] px-1.5 py-0.5 text-micro font-medium text-[var(--mc-status-done-text)]">
        verified
      </span>
    );
  }
  if (status === 'attested') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--mc-status-suggested-bg)] px-1.5 py-0.5 text-micro font-medium text-[var(--mc-status-suggested-text)]">
        attested
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe-secondary">
      unknown
    </span>
  );
}

function StagePills({ current }: { current: SopStage }) {
  const currentIdx = STAGE_ORDER.indexOf(current);
  return (
    <div className="flex flex-wrap gap-1" data-testid="sop-stage-pills">
      {STAGE_ORDER.map((stage, idx) => {
        const isCurrent = stage === current;
        const isPast = idx < currentIdx;
        let className = 'rounded-full px-2 py-0.5 text-micro font-medium transition-colors';
        if (isCurrent) {
          className += ' bg-[var(--mc-accent)] text-white';
        } else if (isPast) {
          className += ' bg-[var(--console-border-soft)] text-cafe-secondary';
        } else {
          className += ' bg-[var(--console-hover-bg)] text-cafe-muted';
        }
        return (
          <span key={stage} className={className} data-testid={`sop-stage-${stage}`}>
            {STAGE_LABELS[stage]}
          </span>
        );
      })}
    </div>
  );
}

function tryResolveWorkflowSopSkill(sop: WorkflowSop) {
  try {
    return resolveWorkflowSopSkill(sop);
  } catch {
    return null;
  }
}

export function WorkflowSopPanel({ backlogItemId }: WorkflowSopPanelProps) {
  const [sop, setSop] = useState<WorkflowSop | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const loadSop = useCallback(async (itemId: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setFetchError(null);
    try {
      const response = await apiFetch(`/api/backlog/${encodeURIComponent(itemId)}/workflow-sop`);
      if (seq !== requestSeq.current) return;
      if (response.status === 404) {
        setSop(null);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed: ${response.status}`);
      }
      const data = (await response.json()) as WorkflowSop;
      setSop(data);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setFetchError(err instanceof Error ? err.message : '加载 SOP 失败');
      setSop(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!backlogItemId) {
      setSop(null);
      setFetchError(null);
      return;
    }
    void loadSop(backlogItemId);
  }, [backlogItemId, loadSop]);

  if (!backlogItemId) {
    return (
      <section
        className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="mc-workflow-sop"
      >
        <p className="text-xs text-cafe-secondary">选择一个 backlog 项查看 SOP 状态</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section
        className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="mc-workflow-sop"
      >
        <p className="text-xs text-cafe-secondary">加载 SOP 告示牌中...</p>
      </section>
    );
  }

  if (fetchError) {
    return (
      <section
        className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="mc-workflow-sop"
      >
        <p className="text-xs text-conn-red-text">{fetchError}</p>
      </section>
    );
  }

  if (!sop) {
    return (
      <section
        className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="mc-workflow-sop"
      >
        <p className="rounded-lg bg-[var(--console-shell-bg)] px-2 py-2 text-xs text-cafe-secondary">
          暂无 SOP 告示牌数据
        </p>
      </section>
    );
  }

  const checkEntries = Object.entries(sop.checks) as [keyof WorkflowSop['checks'], CheckStatus][];
  const resolvedSkill = tryResolveWorkflowSopSkill(sop);

  if (!resolvedSkill) {
    return (
      <section
        className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="mc-workflow-sop"
      >
        <div className="mb-2">
          <h2 className="text-sm font-semibold text-cafe">SOP 告示牌</h2>
          <p className="text-micro text-cafe-secondary">{sop.featureId}</p>
        </div>
        <p className="rounded-lg bg-[var(--console-shell-bg)] px-2 py-2 text-xs text-cafe-secondary">
          SOP 告示牌数据需要更新
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl bg-[var(--console-card-bg)] p-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
      data-testid="mc-workflow-sop"
    >
      {/* Header */}
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-cafe">SOP 告示牌</h2>
        <p className="text-micro text-cafe-secondary">{sop.featureId}</p>
      </div>

      {/* Stage pills */}
      <div className="mb-3">
        <StagePills current={sop.stage} />
      </div>

      {/* Baton holder + next skill */}
      <div className="mb-3 rounded-xl bg-[var(--console-card-bg)] px-2.5 py-2 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
        <p className="text-xs text-cafe-secondary">
          接力棒：
          <span className="font-semibold text-cafe" data-testid="sop-baton-holder">
            {sop.batonHolder}
          </span>
        </p>
        <p className="text-xs text-cafe-secondary" data-testid="sop-next-skill">
          {resolvedSkill.source === 'override' ? '手动 override：' : '定义建议：'}
          <span className="font-medium text-cafe-secondary">{resolvedSkill.skill}</span>
        </p>
      </div>

      {/* Resume capsule */}
      <div
        className="mb-3 rounded-xl bg-[var(--console-card-bg)] px-2.5 py-2 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        data-testid="sop-resume-capsule"
      >
        <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-cafe-secondary">Resume Capsule</p>
        <p className="text-xs text-cafe">
          <span className="font-medium text-cafe-secondary">Goal：</span>
          {sop.resumeCapsule.goal}
        </p>
        {sop.resumeCapsule.done.length > 0 && (
          <div className="mt-1">
            <span className="text-micro font-medium text-cafe-secondary">Done：</span>
            <ul className="ml-3 list-disc">
              {sop.resumeCapsule.done.map((item, i) => (
                <li key={i} className="text-xs text-cafe">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-1 text-xs text-cafe">
          <span className="font-medium text-cafe-secondary">Focus：</span>
          {sop.resumeCapsule.currentFocus}
        </p>
      </div>

      {/* Checks */}
      <div className="mb-2 space-y-1" data-testid="sop-checks">
        <p className="text-micro font-semibold uppercase tracking-wide text-cafe-secondary">Checks</p>
        {checkEntries.map(([key, status]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-xs text-cafe-secondary">{CHECK_LABELS[key]}</span>
            <CheckBadge status={status} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="console-divider-t pt-1.5">
        <p className="text-micro text-cafe-muted">
          更新于{' '}
          {new Date(sop.updatedAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          by {sop.updatedBy}
        </p>
      </div>
    </section>
  );
}
