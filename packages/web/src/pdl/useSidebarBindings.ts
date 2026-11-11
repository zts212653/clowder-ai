'use client';
import type { ThreadAttentionGroup, ThreadAttentionPreferences } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GroupUndoReceipt } from '@/components/ThreadSidebar/search-group-types';
import type { ThreadAttentionGroupCommand } from '@/components/ThreadSidebar/use-attention-clusters';
import type { ThreadLabel } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { extractPendingLabelSuggestions, filterSuggestions, type PendingLabelSpec } from '@/utils/batch-apply-labels';
import { invalidateSidebarProjection, refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

export interface SidebarOwner {
  preferences: ThreadAttentionPreferences & { groups: ThreadAttentionGroup[]; undo?: GroupUndoReceipt };
  labels: ThreadLabel[];
}

export interface SidebarSource {
  owner: SidebarOwner | null;
  classification: {
    phase: string;
    error: string;
    newLabels: PendingLabelSpec[];
    suggestions: { threadId: string; labels: string[]; accepted: boolean }[];
  };
  attention: { id: string; unreadCount: number }[];
}

export function useSidebarBindings(data: ChatData, needed: boolean | number = false) {
  const projection = useSidebarProjectionStore((s) => s.rows);
  const read = useRef<{ owner: SidebarOwner | null; error: unknown }>({ owner: null, error: null });
  const [, changed] = useState(0);
  const classification = useRef<{
    phase: string;
    error: string;
    newLabels: PendingLabelSpec[];
    suggestions: { threadId: string; labels: string[]; accepted: boolean }[];
  }>({ phase: 'idle', error: '', newLabels: [], suggestions: [] });
  const source = useRef<SidebarSource>({ owner: null, classification: classification.current, attention: [] });
  const attention = useMemo(() => projection.map(({ id, unreadCount }) => ({ id, unreadCount })), [projection]);
  if (source.current.attention !== attention) source.current = { ...source.current, attention };
  const publish = () => {
    source.current = { ...source.current, owner: read.current.owner };
    source.current = { ...source.current, classification: classification.current };
    changed((n) => n + 1);
  };
  const accept = (owner: SidebarOwner) => {
    read.current = { owner, error: null };
    publish();
  };
  const load = async () => {
    try {
      const [preferences, labels] = await Promise.all([
        request<SidebarOwner['preferences']>('/api/config/thread-attention'),
        request<ThreadLabel[]>('/api/labels'),
        refreshSidebarThreadSnapshot(),
      ]);
      accept({ preferences, labels });
    } catch (error) {
      read.current = { owner: null, error };
      publish();
      throw error;
    }
  };
  useEffect(() => {
    if (needed) void load().catch(() => {});
  }, [needed]);
  const action = async (name: string, args: Record<string, string>) => {
    switch (name) {
      case 'clDismiss':
        classification.current = { phase: 'idle', error: '', newLabels: [], suggestions: [] };
        publish();
        return true;
      case 'clSuggest': {
        const state = classification.current;
        Object.assign(state, { phase: 'generating', error: '', newLabels: [], suggestions: [] });
        publish();
        try {
          const labels = read.current.owner!.labels;
          const unclassified = data.threads.filter(
            (t) => t.id !== 'default' && !t.systemKind && !t.deletedAt && !t.labels?.length,
          );
          const organizer =
            data.threads.find((t) => t.title === 'Thread 整理助手') ??
            (await write<{ id: string }>('/api/threads', { title: 'Thread 整理助手' }));
          const format = labels.length
            ? '<!-- SUGGESTIONS_JSON:{"threadId1":["labelId1"]} -->'
            : '<!-- SUGGESTIONS_JSON:{"newLabels":[{"name":"标签名","color":"#hex"}],"assignments":{"threadId1":["标签名"]}} -->';
          const content = [
            '帮我整理未分类的 thread。只给建议，不修改任何标签。',
            JSON.stringify({ labels, threads: unclassified.slice(0, 50).map((t) => ({ id: t.id, title: t.title })) }),
            '请在回复末尾附上机器可读建议，用上面列出的 ID：',
            format,
          ].join('\n');
          // every dispatch ends in a terminal reply: wait for it (pushed for any thread), then read once
          const settled = new Promise<void>((resolve) => {
            const on = (event: Event) => {
              const detail = (event as CustomEvent<{ threadId: string; catId: string | null }>).detail;
              if (detail.threadId !== organizer.id || !detail.catId) return;
              window.removeEventListener('cat-cafe:response-settled', on);
              resolve();
            };
            window.addEventListener('cat-cafe:response-settled', on);
          });
          const sentAt = Date.now();
          await write('/api/messages', { threadId: organizer.id, content });
          await settled;
          const page = await request<{
            messages: { catId?: string; timestamp: number; isDraft?: boolean; content: string }[];
          }>(`/api/messages?threadId=${encodeURIComponent(organizer.id)}&limit=5`);
          const match = page.messages
            .filter((m) => m.catId && m.timestamp > sentAt && !m.isDraft)
            .map((m) => m.content.match(/<!-- SUGGESTIONS_JSON:([\s\S]*?) -->/))
            .find(Boolean);
          if (!match) throw new Error('common.dataError');
          const raw = JSON.parse(match[1]) as Record<string, unknown>,
            ids = new Set(unclassified.map((t) => t.id));
          const pending = extractPendingLabelSuggestions(raw, ids);
          const assignments = pending
            ? new Map([...pending.nameAssignments].map(([id, names]) => [id, names.map((name) => 'pending:' + name)]))
            : filterSuggestions(raw, ids, new Set(labels.map((l) => l.id)));
          state.newLabels = pending?.pendingLabels ?? [];
          state.suggestions = [...assignments].map(([threadId, labels]) => ({ threadId, labels, accepted: false }));
          state.phase = 'review';
          return true;
        } catch (e) {
          state.error = e instanceof Error ? e.message : 'common.dataError';
          state.phase = 'review';
        } finally {
          publish();
        }
        return true;
      }
      case 'clAccept': {
        const state = classification.current;
        const ids = args.ids ? (JSON.parse(args.ids) as string[]) : state.suggestions.map((s) => s.threadId);
        const reviewed = state.suggestions.filter((s) => !s.accepted && ids.includes(s.threadId));
        for (const row of reviewed) {
          const labels: string[] = [];
          for (const id of row.labels) {
            if (!id.startsWith('pending:')) {
              labels.push(id);
              continue;
            }
            const spec = state.newLabels.find((l) => l.name === id.slice(8))!;
            const known = read.current.owner!.labels.find((l) => l.name === spec.name);
            const label = known ?? (await write<ThreadLabel>('/api/labels', spec));
            if (!known) accept({ ...read.current.owner!, labels: [...read.current.owner!.labels, label] });
            labels.push(label.id);
          }
          await write(`/api/threads/${encodeURIComponent(row.threadId)}`, { labels }, 'PATCH');
          row.labels = labels;
          row.accepted = true;
        }
        state.phase = state.suggestions.every((s) => s.accepted) ? 'done' : 'review';
        publish();
        await invalidateSidebarProjection();
        return true;
      }
      case 'sidebarRead':
        await load();
        return true;
      case 'sidebarGroupWrite': {
        const command = JSON.parse(args.value) as ThreadAttentionGroupCommand;
        const preferences = await write<SidebarOwner['preferences']>('/api/config/thread-attention/groups', command);
        accept({ ...read.current.owner!, preferences });
        await invalidateSidebarProjection();
        return true;
      }
      case 'sidebarLabelCreate': {
        const label = await write<ThreadLabel>('/api/labels', { name: args.name, color: args.color });
        accept({ ...read.current.owner!, labels: [...read.current.owner!.labels, label] });
        return true;
      }
      case 'sidebarLabelDelete':
        await request(`/api/labels/${encodeURIComponent(args.id)}`, { method: 'DELETE' });
        await Promise.all([load(), invalidateSidebarProjection()]);
        return true;
      case 'sidebarLabels':
        await write(`/api/threads/${encodeURIComponent(args.id)}`, { labels: JSON.parse(args.value) }, 'PATCH');
        await invalidateSidebarProjection();
        return true;
      case 'sidebarArchive': {
        const targets = data.threads.filter(
          (t) =>
            t.projectPath === args.id && t.id !== 'default' && !t.systemKind && !t.connectorHubState && !t.deletedAt,
        );
        const results = await Promise.allSettled(
          targets.map((t) => request(`/api/threads/${encodeURIComponent(t.id)}`, { method: 'DELETE' })),
        );
        await Promise.all([load(), invalidateSidebarProjection()]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return true;
      }
      case 'sidebarRestore':
        await Promise.all(
          (JSON.parse(args.value) as string[]).map((id) => write(`/api/threads/${encodeURIComponent(id)}/restore`, {})),
        );
        await Promise.all([load(), invalidateSidebarProjection()]);
        return true;
      case 'sidebarReveal':
        await write('/api/workspace/reveal-project', { projectPath: args.id });
        return true;
      default:
        return false;
    }
  };
  return { action, data: source.current, error: read.current.error };
}
