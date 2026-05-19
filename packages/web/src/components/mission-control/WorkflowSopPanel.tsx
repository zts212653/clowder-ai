'use client';

import type { CheckStatus, SopStage, WorkflowSop } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface WorkflowSopPanelProps {
  backlogItemId: string | null;
}

const STAGE_LABELS: Record<SopStage, string> = {
  kickoff: '立项',
  impl: '实现',
  quality_gate: '自检',
  review: 'Review',
  merge: '合入',
  completion: '完成',
};

const STAGE_ORDER: SopStage[] = ['kickoff', 'impl', 'quality_gate', 'review', 'merge', 'completion'];

const CHECK_LABELS: Record<keyof WorkflowSop['checks'], string> = {
  remoteMainSynced: 'Main 同步',
  qualityGatePassed: '质量门禁',
  reviewApproved: 'Review 放行',
  visionGuardDone: '愿景守护',
};

function CheckBadge({ status }: { status: CheckStatus }) {
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-[#E8F5E8] px-1.5 py-0.5 text-[10px] font-medium text-[#3A7A3A]">
        verified
      </span>
    );
  }
  if (status === 'attested') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-[#FFF3D6] px-1.5 py-0.5 text-[10px] font-medium text-[#8A6D2B]">
        attested
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-[#F0EBE3] px-1.5 py-0.5 text-[10px] font-medium text-[#8B7864]">
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
        let className = 'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors';
        if (isCurrent) {
          className += ' bg-[#8B6F47] text-white';
        } else if (isPast) {
          className += ' bg-[#D4C4A8] text-[#6B5D4F]';
        } else {
          className += ' bg-[#F0EBE3] text-[#A89880]';
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
      <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-workflow-sop">
        <p className="text-xs text-[#8B7864]">选择一个 backlog 项查看 SOP 状态</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-workflow-sop">
        <p className="text-xs text-[#8B7864]">加载 SOP 告示牌中...</p>
      </section>
    );
  }

  if (fetchError) {
    return (
      <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-workflow-sop">
        <p className="text-xs text-conn-red-text">{fetchError}</p>
      </section>
    );
  }

  if (!sop) {
    return (
      <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-workflow-sop">
        <p className="rounded-lg border border-dashed border-[#DDCCB5] px-2 py-2 text-xs text-[#8B7864]">
          暂无 SOP 告示牌数据
        </p>
      </section>
    );
  }

  const checkEntries = Object.entries(sop.checks) as [keyof WorkflowSop['checks'], CheckStatus][];

  return (
    <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-workflow-sop">
      {/* Header */}
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-[#2C2118]">SOP 告示牌</h2>
        <p className="text-[10px] text-[#7B6956]">{sop.featureId}</p>
      </div>

      {/* Stage pills */}
      <div className="mb-3">
        <StagePills current={sop.stage} />
      </div>

      {/* Baton holder + next skill */}
      <div className="mb-3 rounded-xl border border-[#EADFCF] bg-[#FFF9F0] px-2.5 py-2">
        <p className="text-xs text-[#6E5A46]">
          接力棒：
          <span className="font-semibold text-[#4B3A2A]" data-testid="sop-baton-holder">
            {sop.batonHolder}
          </span>
        </p>
        {sop.nextSkill && (
          <p className="text-xs text-[#6E5A46]">
            下一步 Skill：<span className="font-medium text-[#8B6F47]">{sop.nextSkill}</span>
          </p>
        )}
      </div>

      {/* Resume capsule */}
      <div
        className="mb-3 rounded-xl border border-[#EADFCF] bg-[#FEFCF7] px-2.5 py-2"
        data-testid="sop-resume-capsule"
      >
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#9A866F]">Resume Capsule</p>
        <p className="text-xs text-[#4B3A2A]">
          <span className="font-medium text-[#6E5A46]">Goal：</span>
          {sop.resumeCapsule.goal}
        </p>
        {sop.resumeCapsule.done.length > 0 && (
          <div className="mt-1">
            <span className="text-[10px] font-medium text-[#6E5A46]">Done：</span>
            <ul className="ml-3 list-disc">
              {sop.resumeCapsule.done.map((item, i) => (
                <li key={i} className="text-xs text-[#4B3A2A]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-1 text-xs text-[#4B3A2A]">
          <span className="font-medium text-[#6E5A46]">Focus：</span>
          {sop.resumeCapsule.currentFocus}
        </p>
      </div>

      {/* Checks */}
      <div className="mb-2 space-y-1" data-testid="sop-checks">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[#9A866F]">Checks</p>
        {checkEntries.map(([key, status]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-xs text-[#6E5A46]">{CHECK_LABELS[key]}</span>
            <CheckBadge status={status} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-[#F0E8DA] pt-1.5">
        <p className="text-[10px] text-[#A89880]">
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
