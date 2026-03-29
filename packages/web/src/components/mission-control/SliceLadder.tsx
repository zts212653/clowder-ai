'use client';

import type { Slice, SliceStatus, SliceType } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const TYPE_COLORS: Record<SliceType, string> = {
  learning: '#5B9BD5',
  value: '#7CB87C',
  hardening: '#B07CC5',
};

const STATUS_STYLES: Record<SliceStatus, { bg: string; text: string }> = {
  planned: { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary' },
  in_progress: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  delivered: { bg: 'bg-green-100', text: 'text-green-800' },
  validated: { bg: 'bg-blue-100', text: 'text-blue-800' },
};

const NEXT_STATUS: Record<SliceStatus, SliceStatus | null> = {
  planned: 'in_progress',
  in_progress: 'delivered',
  delivered: 'validated',
  validated: null,
};

interface SliceLadderProps {
  projectId: string;
  slices: Slice[];
  onUpdate: () => void;
}

export function SliceLadder({ projectId, slices, onUpdate }: SliceLadderProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [sliceType, setSliceType] = useState<SliceType>('value');
  const [description, setDescription] = useState('');
  const [actor, setActor] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [verifiableOutcome, setVerifiableOutcome] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const sorted = [...slices].sort((a, b) => a.order - b.order);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleReorder = useCallback(
    async (id1: string, id2: string) => {
      await apiFetch(`/api/external-projects/${projectId}/slices/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id1, id2 }),
      });
      onUpdate();
    },
    [projectId, onUpdate],
  );

  const handleStatusChange = useCallback(
    async (id: string, status: SliceStatus) => {
      await apiFetch(`/api/external-projects/${projectId}/slices/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      onUpdate();
    },
    [projectId, onUpdate],
  );

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/external-projects/${projectId}/slices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sliceType, description, actor, workflow, verifiableOutcome }),
      });
      if (res.ok) {
        setShowForm(false);
        setName('');
        setDescription('');
        setActor('');
        setWorkflow('');
        setVerifiableOutcome('');
        onUpdate();
      }
    } finally {
      setSubmitting(false);
    }
  }, [projectId, name, sliceType, description, actor, workflow, verifiableOutcome, onUpdate]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[#2B2118]">切片計劃</div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-[#8B6F47] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139]"
        >
          {showForm ? '取消' : 'Add Slice'}
        </button>
      </div>

      {/* Slice list */}
      {sorted.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed border-[#D8C6AD] bg-[#FBF7F0] p-6 text-center text-xs text-[#9A866F]">
          暂无切片
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((slice, idx) => {
            const sStyle = STATUS_STYLES[slice.status];
            const isExpanded = expanded.has(slice.id);
            const nextStatus = NEXT_STATUS[slice.status];
            return (
              <div key={slice.id} className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-xs">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => void handleReorder(slice.id, sorted[idx - 1].id)}
                      className="text-[10px] text-[#8B6F47] disabled:opacity-20"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={idx === sorted.length - 1}
                      onClick={() => void handleReorder(slice.id, sorted[idx + 1].id)}
                      className="text-[10px] text-[#8B6F47] disabled:opacity-20"
                    >
                      ▼
                    </button>
                  </div>
                  <button type="button" onClick={() => toggle(slice.id)} className="flex flex-1 items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                      style={{ backgroundColor: TYPE_COLORS[slice.sliceType] }}
                    >
                      {slice.sliceType}
                    </span>
                    <span className="font-medium text-[#2B2118]">{slice.name}</span>
                  </button>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sStyle.bg} ${sStyle.text}`}>
                    {slice.status.replace('_', ' ')}
                  </span>
                  {nextStatus && (
                    <button
                      type="button"
                      onClick={() => void handleStatusChange(slice.id, nextStatus)}
                      className="rounded bg-[#F4EFE7] px-2 py-0.5 text-[10px] font-medium text-[#8B6F47] hover:bg-[#E7DAC7]"
                    >
                      → {nextStatus.replace('_', ' ')}
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="mt-2 space-y-1 border-t border-[#E7DAC7] pt-2 text-[#6B5D4F]">
                    {slice.description && (
                      <div>
                        <strong>Description:</strong> {slice.description}
                      </div>
                    )}
                    {slice.actor && (
                      <div>
                        <strong>Actor:</strong> {slice.actor}
                      </div>
                    )}
                    {slice.workflow && (
                      <div>
                        <strong>Workflow:</strong> {slice.workflow}
                      </div>
                    )}
                    {slice.verifiableOutcome && (
                      <div>
                        <strong>Verifiable Outcome:</strong> {slice.verifiableOutcome}
                      </div>
                    )}
                    {slice.cardIds.length > 0 && (
                      <div>
                        <strong>Linked Cards:</strong> {slice.cardIds.map((id) => id.slice(0, 8)).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Slice form */}
      {showForm && (
        <div
          style={{
            background: '#FFFDF8',
            border: '1px solid #E7DAC7',
            borderRadius: 10,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Slice name"
            style={{ border: '1px solid #E7DAC7', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
          />
          <select
            value={sliceType}
            onChange={(e) => setSliceType(e.target.value as SliceType)}
            style={{ border: '1px solid #E7DAC7', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
          >
            <option value="learning">Learning</option>
            <option value="value">Value</option>
            <option value="hardening">Hardening</option>
          </select>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={2}
            style={{
              border: '1px solid #E7DAC7',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          <input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="Actor"
            style={{ border: '1px solid #E7DAC7', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
          />
          <input
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            placeholder="Workflow"
            style={{ border: '1px solid #E7DAC7', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
          />
          <textarea
            value={verifiableOutcome}
            onChange={(e) => setVerifiableOutcome(e.target.value)}
            placeholder="Verifiable outcome"
            rows={2}
            style={{
              border: '1px solid #E7DAC7',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={submitting || !name.trim()}
            style={{
              background: '#8B6F47',
              color: 'white',
              borderRadius: 8,
              padding: '6px 0',
              fontSize: 13,
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
              opacity: submitting || !name.trim() ? 0.4 : 1,
            }}
          >
            {submitting ? '创建中...' : '创建切片'}
          </button>
        </div>
      )}
    </div>
  );
}
