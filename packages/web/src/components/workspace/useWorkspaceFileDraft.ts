'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import {
  afterWorkspaceFileSave,
  type WorkspaceFileDraft,
  workspaceFileDraftKey,
  workspaceFileDraftSchema,
} from './workspace-file-draft';

interface DraftState {
  key: string | null;
  ready: boolean;
  draft: WorkspaceFileDraft | null;
  error: string | null;
  generation: number;
}
export function useWorkspaceFileDraft(
  worktreeId: string | null | undefined,
  path: string,
  baseSha256: string | undefined,
) {
  const supported = Boolean(worktreeId && baseSha256 && /^[a-f0-9]{64}$/.test(baseSha256));
  const [state, setState] = useState<DraftState>({
    key: null,
    ready: !supported,
    draft: null,
    error: null,
    generation: 0,
  });
  const [attempt, retryLoad] = useState(0);
  const current = useRef(state);
  const mounted = useRef(true);
  const writerId = useRef(crypto.randomUUID());
  function publish(next: DraftState) {
    current.current = next;
    if (mounted.current) setState(next);
  }
  useEffect(() => {
    mounted.current = true;
    writerId.current = crypto.randomUUID();
    const controller = new AbortController();
    if (!worktreeId || !supported) {
      publish({ key: null, ready: true, draft: null, error: null, generation: current.current.generation + 1 });
      return () => {
        mounted.current = false;
      };
    }
    publish({ key: null, ready: false, draft: null, error: null, generation: current.current.generation + 1 });
    void (async () => {
      try {
        const response = await apiFetch('/api/session', { signal: controller.signal });
        if (!response.ok) throw new Error('identity');
        const { userId } = z.object({ userId: z.string().min(1) }).parse(await response.json());
        const key = workspaceFileDraftKey(userId, worktreeId, path);
        const raw = localStorage.getItem(key);
        const draft = raw ? workspaceFileDraftSchema.parse(JSON.parse(raw)) : null;
        if (!controller.signal.aborted)
          publish({ key, ready: true, draft, error: null, generation: current.current.generation + 1 });
      } catch {
        if (!controller.signal.aborted)
          publish({ ...current.current, ready: false, error: '无法读取当前用户的文件草稿，编辑尚未开启。请重试。' });
      }
    })();
    return () => {
      controller.abort();
      mounted.current = false;
    };
  }, [worktreeId, path, supported, attempt]);

  function persist(draft: WorkspaceFileDraft | null, refresh = false): boolean {
    const prior = current.current;
    if (!prior.key || !prior.ready) return false;
    try {
      if (draft) localStorage.setItem(prior.key, JSON.stringify(workspaceFileDraftSchema.parse(draft)));
      else localStorage.removeItem(prior.key);
      publish({ ...prior, draft, error: null, generation: prior.generation + Number(refresh) });
      return true;
    } catch {
      publish({
        ...prior,
        ...(draft ? { draft } : {}),
        error: '编辑仍保留在本页，但草稿尚未保存成功；请重试保存草稿。',
      });
      return false;
    }
  }
  function update(text: string) {
    if (!baseSha256 || !current.current.ready) return;
    const prior = current.current.draft;
    persist({
      v: 1,
      revision: crypto.randomUUID(),
      writerId: writerId.current,
      baseSha256: prior?.baseSha256 ?? baseSha256,
      text,
      ...(prior?.priorBases ? { priorBases: prior.priorBases } : {}),
    });
  }
  function rebase() {
    const draft = current.current.draft;
    if (!draft || !baseSha256) return;
    persist(
      {
        ...draft,
        revision: crypto.randomUUID(),
        writerId: writerId.current,
        baseSha256,
        priorBases: [...(draft.priorBases ?? []), draft.baseSha256],
      },
      true,
    );
  }
  function snapshot() {
    return { key: current.current.key, draft: current.current.draft };
  }
  function saved(sent: ReturnType<typeof snapshot>, sha256: string) {
    if (!sent.key || !sent.draft) return;
    try {
      const raw = localStorage.getItem(sent.key);
      if (!raw) return;
      const stored = workspaceFileDraftSchema.parse(JSON.parse(raw));
      const memory = current.current.key === sent.key ? current.current.draft : null;
      const latest =
        memory?.writerId === sent.draft.writerId &&
        stored.writerId === sent.draft.writerId &&
        memory.baseSha256 === sent.draft.baseSha256
          ? memory
          : stored;
      const next = afterWorkspaceFileSave(latest, sent.draft, sha256);
      if (next === stored) return;
      if (next) localStorage.setItem(sent.key, JSON.stringify(next));
      else localStorage.removeItem(sent.key);
      if (mounted.current && current.current.key === sent.key && current.current.draft?.revision === latest.revision)
        publish({ ...current.current, draft: next, error: null });
    } catch {
      if (mounted.current && current.current.key === sent.key)
        publish({ ...current.current, error: '文件已收到保存回执，但本地草稿更新失败；编辑内容仍保留。' });
    }
  }
  return {
    ...state,
    supported,
    current,
    update,
    rebase,
    snapshot,
    saved,
    clear: () => persist(null, true),
    retry: () => (current.current.ready ? persist(current.current.draft) : retryLoad((value) => value + 1)),
    drifted: Boolean(state.draft && baseSha256 && state.draft.baseSha256 !== baseSha256),
  };
}
