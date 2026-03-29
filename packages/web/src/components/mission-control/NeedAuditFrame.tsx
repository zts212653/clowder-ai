'use client';

import type { NeedAuditFrame as NeedAuditFrameType } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface NeedAuditFrameProps {
  projectId: string;
  frame: NeedAuditFrameType | null;
  onSaved: (frame: NeedAuditFrameType) => void;
}

export function NeedAuditFrame({ projectId, frame, onSaved }: NeedAuditFrameProps) {
  const [sponsor, setSponsor] = useState(frame?.sponsor ?? '');
  const [motivation, setMotivation] = useState(frame?.motivation ?? '');
  const [successMetric, setSuccessMetric] = useState(frame?.successMetric ?? '');
  const [constraints, setConstraints] = useState(frame?.constraints ?? '');
  const [currentWorkflow, setCurrentWorkflow] = useState(frame?.currentWorkflow ?? '');
  const [provenanceMap, setProvenanceMap] = useState(frame?.provenanceMap ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (frame) {
      setSponsor(frame.sponsor);
      setMotivation(frame.motivation);
      setSuccessMetric(frame.successMetric);
      setConstraints(frame.constraints);
      setCurrentWorkflow(frame.currentWorkflow);
      setProvenanceMap(frame.provenanceMap);
    }
  }, [frame]);

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/external-projects/${projectId}/frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sponsor, motivation, successMetric, constraints, currentWorkflow, provenanceMap }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `保存失败: ${res.status}`);
      }
      const body = (await res.json()) as { frame: NeedAuditFrameType };
      onSaved(body.frame);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const fields = [
    { label: '决策发起人 (Sponsor) *', value: sponsor, set: setSponsor, placeholder: '谁拍板？' },
    { label: '为什么现在做 (Motivation)', value: motivation, set: setMotivation, placeholder: '项目动因' },
    { label: '成功指标 (Success Metric) *', value: successMetric, set: setSuccessMetric, placeholder: '什么算成功？' },
    { label: '约束条件 (Constraints)', value: constraints, set: setConstraints, placeholder: '时间/预算/技术约束' },
    {
      label: '现有流程 (Current Workflow)',
      value: currentWorkflow,
      set: setCurrentWorkflow,
      placeholder: '目前怎么做的？',
    },
    { label: '来源追踪 (Provenance Map)', value: provenanceMap, set: setProvenanceMap, placeholder: '各条声明的来源' },
  ];

  return (
    <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-4">
      <h3 className="mb-3 text-sm font-bold text-[#2B2118]">Stage 0: Frame — 六问定位</h3>
      <div className="space-y-3">
        {fields.map((f) => (
          <label key={f.label} className="block">
            <span className="text-xs font-medium text-[#6B5D4F]">{f.label}</span>
            <input
              type="text"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              placeholder={f.placeholder}
              className="mt-1 w-full rounded-lg border border-[#D8C6AD] bg-cafe-surface px-3 py-1.5 text-xs text-[#2B2118] focus:border-[#8B6F47] focus:outline-none"
            />
          </label>
        ))}
      </div>
      {error && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</div>
      )}
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={submitting}
        className="mt-3 w-full rounded-lg bg-[#8B6F47] py-1.5 text-xs font-medium text-white hover:bg-[#7A6139] disabled:opacity-40"
      >
        {submitting ? '保存中...' : frame ? '更新 Frame' : '保存 Frame'}
      </button>
    </div>
  );
}
