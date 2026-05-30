'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type Status = 'pending' | 'approving' | 'approved' | 'rejected';

interface ProposalSnapshot {
  proposalId: string;
  status: Status;
  createdThreadId?: string;
}

interface ProposalCardProps {
  block: RichCardBlock;
  messageId?: string;
}

interface ProposalFieldEdits {
  title: string;
  parentThreadId: string;
  preferredCats: string;
  initialMessage: string;
}

function extractProposalId(block: RichCardBlock): string | null {
  const approveAction = block.actions?.find((a) => a.action === 'propose:approve');
  const id = approveAction?.payload?.proposalId;
  return typeof id === 'string' ? id : null;
}

function readField(block: RichCardBlock, label: string): string {
  return block.fields?.find((f) => f.label === label)?.value ?? '';
}

function parsePreferredCats(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '（未指定）');
}

export function ProposalCard({ block }: ProposalCardProps) {
  const proposalId = useMemo(() => extractProposalId(block), [block]);
  const [status, setStatus] = useState<Status>('pending');
  const [resultThreadId, setResultThreadId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinOnApprove, setPinOnApprove] = useState(false);
  const [edits, setEdits] = useState<ProposalFieldEdits>(() => ({
    title: block.title.replace(/^📥 提议新建 thread：/, ''),
    parentThreadId: readField(block, '父 Thread'),
    preferredCats: readField(block, '建议成员'),
    initialMessage: readField(block, '首条消息'),
  }));

  // Mount: fetch real status so reload / multi-tab views don't drift to stale "pending".
  useEffect(() => {
    if (!proposalId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/proposals/${proposalId}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { proposal: ProposalSnapshot };
        if (data.proposal && !cancelled) {
          setStatus(data.proposal.status);
          if (data.proposal.createdThreadId) setResultThreadId(data.proposal.createdThreadId);
        }
      } catch {
        // best-effort sync; keep the optimistic 'pending' if fetch fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  // Subscribe to socket-driven updates so other tabs / async approves reflect immediately.
  useEffect(() => {
    if (!proposalId || typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ProposalSnapshot>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      setStatus(detail.status);
      if (detail.createdThreadId) setResultThreadId(detail.createdThreadId);
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    return () => {
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [proposalId]);

  const approve = useCallback(async () => {
    if (!proposalId) return;
    setLoading(true);
    setError(null);
    const body: Record<string, unknown> = editing
      ? {
          title: edits.title.trim() || undefined,
          parentThreadId: edits.parentThreadId.trim() || undefined,
          preferredCats: parsePreferredCats(edits.preferredCats),
          initialMessage: edits.initialMessage.trim() ? edits.initialMessage.trim() : null,
        }
      : {};
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { threadId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const newThreadId = data.threadId ?? null;
      setResultThreadId(newThreadId);
      setStatus('approved');
      setEditing(false);
      // AC-F7: persist pin via PATCH /api/threads/:id (server-side) + sync local store for immediate sidebar UX
      if (pinOnApprove && newThreadId) {
        try {
          const pinRes = await apiFetch(`/api/threads/${newThreadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: true }),
          });
          // Only sync local store if server actually persisted the pin
          if (pinRes.ok) {
            useChatStore.getState().updateThreadPin(newThreadId, true);
          }
        } catch {
          // best-effort: pin failure should not block the approve success UX
        }
      }
      // AC-F8: auto-navigate to the new thread
      if (newThreadId) {
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批准失败');
    } finally {
      setLoading(false);
    }
  }, [proposalId, editing, edits, pinOnApprove]);

  const reject = useCallback(async () => {
    if (!proposalId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('rejected');
    } catch (err) {
      setError(err instanceof Error ? err.message : '驳回失败');
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  if (!proposalId) {
    return (
      <div className="border-l-4 border-l-red-400 bg-red-50 dark:bg-red-950/30 rounded-r-lg p-3 text-xs text-red-600">
        Proposal card missing proposalId
      </div>
    );
  }

  return (
    <div className="border-l-4 border-l-blue-400 bg-blue-50 dark:bg-blue-950/30 rounded-r-lg p-3">
      <div className="font-medium text-sm">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-gray-600 dark:text-gray-300 [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {!editing && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
          <div>
            <span className="text-gray-500">父 Thread:</span>{' '}
            <span className="font-mono break-all">{edits.parentThreadId}</span>
          </div>
          <div>
            <span className="text-gray-500">建议成员:</span>{' '}
            <span className="font-mono break-all">{edits.preferredCats || '（未指定）'}</span>
          </div>
          {edits.initialMessage && (
            <div className="sm:col-span-2">
              <span className="text-gray-500">首条消息:</span> <span>{edits.initialMessage}</span>
            </div>
          )}
        </div>
      )}
      {editing && (
        <div className="mt-2 space-y-1 text-xs">
          <EditField label="标题" value={edits.title} onChange={(v) => setEdits((p) => ({ ...p, title: v }))} />
          <EditField
            label="父 Thread"
            value={edits.parentThreadId}
            onChange={(v) => setEdits((p) => ({ ...p, parentThreadId: v }))}
          />
          <EditField
            label="建议成员 (逗号分隔)"
            value={edits.preferredCats}
            onChange={(v) => setEdits((p) => ({ ...p, preferredCats: v }))}
          />
          <EditField
            label="首条消息"
            value={edits.initialMessage}
            onChange={(v) => setEdits((p) => ({ ...p, initialMessage: v }))}
            multiline
          />
        </div>
      )}
      {status === 'pending' && (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={pinOnApprove}
              onChange={(e) => setPinOnApprove(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            📌 置顶新 thread
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={loading} onClick={approve} className={btnPrimary}>
              {loading ? '处理中...' : editing ? '批准（含编辑）' : '批准并创建'}
            </button>
            <button type="button" disabled={loading} onClick={() => setEditing((v) => !v)} className={btnSecondary}>
              {editing ? '取消编辑' : '编辑'}
            </button>
            <button type="button" disabled={loading} onClick={reject} className={btnDanger}>
              驳回
            </button>
          </div>
        </div>
      )}
      {status === 'approving' && <div className="mt-2 text-xs text-blue-600 dark:text-blue-300">批准中…</div>}
      {status === 'approved' && (
        <div className="mt-2 text-xs text-green-700 dark:text-green-300">
          ✓ 已批准，thread 已创建{' '}
          {resultThreadId ? (
            <button
              type="button"
              data-testid="thread-link"
              onClick={() =>
                pushThreadRouteWithHistory(resultThreadId, typeof window !== 'undefined' ? window : undefined)
              }
              className="font-mono underline hover:text-green-900 dark:hover:text-green-100 cursor-pointer"
            >
              {resultThreadId}
            </button>
          ) : null}
        </div>
      )}
      {status === 'rejected' && <div className="mt-2 text-xs text-red-600 dark:text-red-300">✗ 已驳回</div>}
      {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
    </div>
  );
}

const btnPrimary =
  'text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors';
const btnSecondary =
  'text-xs px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-700 disabled:opacity-50 transition-colors';
const btnDanger =
  'text-xs px-3 py-1 rounded bg-red-100 dark:bg-red-900/40 hover:bg-red-200 dark:hover:bg-red-800/50 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-700 disabled:opacity-50 transition-colors';

function EditField({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-gray-500">{label}:</span>{' '}
      {multiline ? (
        <textarea
          className="mt-0.5 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 font-mono text-xs"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="mt-0.5 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export function isProposalCardBlock(block: RichCardBlock): boolean {
  return block.actions?.some((a) => a.action === 'propose:approve') ?? false;
}
