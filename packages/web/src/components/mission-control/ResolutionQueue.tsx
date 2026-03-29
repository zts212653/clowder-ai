'use client';

import type { IntentCard, ResolutionItem } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  open: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  answered: { bg: 'bg-green-100', text: 'text-green-800' },
  escalated: { bg: 'bg-red-100', text: 'text-red-800' },
};

type NonNullPath = 'confirmation' | 'evidence' | 'artifact' | 'prototype' | 'escalation';
const PATH_OPTIONS: NonNullPath[] = ['confirmation', 'evidence', 'artifact', 'prototype', 'escalation'];

interface ResolutionQueueProps {
  projectId: string;
  resolutions: ResolutionItem[];
  cards: IntentCard[];
  onUpdate: () => void;
}

export function ResolutionQueue({ projectId, resolutions, cards, onUpdate }: ResolutionQueueProps) {
  const [showForm, setShowForm] = useState(false);
  const [cardId, setCardId] = useState('');
  const [path, setPath] = useState<NonNullPath>('confirmation');
  const [question, setQuestion] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [answerText, setAnswerText] = useState<Record<string, string>>({});

  const handleCreate = useCallback(async () => {
    if (!cardId || !question.trim()) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/external-projects/${projectId}/resolutions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, path, question, recommendation }),
      });
      if (res.ok) {
        setShowForm(false);
        setCardId('');
        setQuestion('');
        setRecommendation('');
        onUpdate();
      }
    } finally {
      setSubmitting(false);
    }
  }, [projectId, cardId, path, question, recommendation, onUpdate]);

  const handleAnswer = useCallback(
    async (id: string) => {
      const answer = answerText[id]?.trim();
      if (!answer) return;
      const res = await apiFetch(`/api/external-projects/${projectId}/resolutions/${id}/answer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      if (res.ok) {
        setAnswerText((prev) => ({ ...prev, [id]: '' }));
        onUpdate();
      }
    },
    [projectId, answerText, onUpdate],
  );

  const handleEscalate = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/external-projects/${projectId}/resolutions/${id}/escalate`, {
        method: 'PATCH',
      });
      if (res.ok) onUpdate();
    },
    [projectId, onUpdate],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[#2B2118]">澄清队列</div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-[#8B6F47] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139]"
        >
          {showForm ? '取消' : 'Add Question'}
        </button>
      </div>

      {/* Add Question form */}
      {showForm && (
        <div className="space-y-2 rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-4">
          <select
            value={cardId}
            onChange={(e) => setCardId(e.target.value)}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          >
            <option value="">选择 Card...</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id.slice(0, 8)} — {c.goal.slice(0, 50)}
              </option>
            ))}
          </select>
          <select
            value={path}
            onChange={(e) => setPath(e.target.value as NonNullPath)}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          >
            {PATH_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="问题..."
            rows={2}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          />
          <textarea
            value={recommendation}
            onChange={(e) => setRecommendation(e.target.value)}
            placeholder="建议..."
            rows={2}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={submitting || !cardId || !question.trim()}
            className="w-full rounded-lg bg-[#8B6F47] py-1.5 text-xs font-medium text-white hover:bg-[#7A6139] disabled:opacity-40"
          >
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      )}

      {/* Resolution list */}
      {resolutions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D8C6AD] bg-[#FBF7F0] p-6 text-center text-xs text-[#9A866F]">
          暂无澄清问题
        </div>
      ) : (
        <div className="space-y-2">
          {resolutions.map((item) => {
            const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.open;
            return (
              <div key={item.id} className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-xs">
                <div className="mb-1 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                    {item.status}
                  </span>
                  <span className="rounded bg-[#F4EFE7] px-1.5 py-0.5 text-[10px] font-medium text-[#8B6F47]">
                    {item.path}
                  </span>
                  <span className="text-[10px] text-[#B8A88F]">{item.cardId.slice(0, 8)}</span>
                </div>
                <div className="mb-1 font-medium text-[#2B2118]">{item.question}</div>
                {item.recommendation && (
                  <div className="mb-1 text-[10px] text-[#9A866F]">建议: {item.recommendation}</div>
                )}
                {item.answer && <div className="rounded bg-green-50 px-2 py-1 text-[#2B2118]">{item.answer}</div>}
                {item.status === 'open' && (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={answerText[item.id] ?? ''}
                      onChange={(e) => setAnswerText((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="回答..."
                      className="flex-1 rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAnswer(item.id)}
                      className="rounded bg-green-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-green-700"
                    >
                      Answer
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleEscalate(item.id)}
                      className="rounded bg-red-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-red-700"
                    >
                      Escalate
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
