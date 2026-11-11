'use client';
import {
  type BacklogItem,
  DEVELOPMENT_SOP_DEFINITION,
  type DispatchExecutionDigest,
  type ExternalProject,
  type FeatureDocDetail,
  type IntentCard,
  type NeedAuditFrame,
  type RefluxPattern,
  type ResolutionItem,
  type RiskDetectionResult,
  type Slice,
  type WorkflowSop,
} from '@cat-cafe/shared';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractFeatureId } from '@/components/mission-control/feature-id';
import { useMissionControlStore } from '@/stores/missionControlStore';
import { apiFetch } from '@/utils/api-client';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

interface BoardUi {
  boardV: string;
  hbItem: string | null;
  hbView: string;
  depScope: string;
  node: string | null;
  zoom: number;
  pan: number[];
  extSec?: string;
}
interface ExternalDetail {
  id: string;
  frame: NeedAuditFrame | null;
  cards: IntentCard[];
  items: BacklogItem[];
  digests: DispatchExecutionDigest[];
  resolutions: ResolutionItem[];
  slices: Slice[];
  patterns: RefluxPattern[];
  riskSummary: { signals: Record<string, number>; totalCards: number; cardsWithRisks: number };
}
interface FeatureRead {
  id: string;
  load: string;
  value?: FeatureDocDetail | null;
  error?: string;
}
function BoardFeatureBinding({
  id,
  generation,
  changed,
}: {
  id: string;
  generation: number;
  changed: (read: FeatureRead) => void;
}) {
  useEffect(() => {
    const abort = new AbortController();
    changed({ id, load: 'loading', error: '' });
    void apiFetch(`/api/backlog/feature-doc-detail?${new URLSearchParams({ featureId: id })}`, { signal: abort.signal })
      .then(async (response) => {
        if (response.status === 404) return null;
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        return value as FeatureDocDetail;
      })
      .then(
        (value) => {
          if (!abort.signal.aborted) {
            changed({ id, load: '', value });
            window.clowderChat.dataOk('board.doc.' + id);
          }
        },
        (error: Error) => {
          if (!abort.signal.aborted) {
            changed({ id, load: 'error', error: error.message });
            window.clowderChat.dataError('board.doc.' + id, error);
          }
        },
      );
    return () => abort.abort();
  }, [id, generation, changed]);
  return null;
}
export function useBoardBindings(
  data: ChatData,
  ui: BoardUi,
  needed: boolean | number = false,
  neededDocs: readonly string[] = [],
) {
  const items = useMissionControlStore((s) => s.items);
  const featureIds = useMemo(
    () => items.map((item) => ({ id: item.id, featureId: extractFeatureId(item.tags) })),
    [items],
  );
  const [read, setRead] = useState({ load: 'loading' });
  const [docs, setDocs] = useState<Record<string, FeatureRead>>({});
  const docChanged = useCallback(
    (value: FeatureRead) => setDocs((current) => ({ ...current, [value.id]: { ...current[value.id], ...value } })),
    [],
  );
  const [generation, refresh] = useState(0);
  const [projects, setProjects] = useState<ExternalProject[]>([]);
  const [browsing, browse] = useState(false);
  const [projectsLoad, setProjectsLoad] = useState('loading');
  const [externalId, setExternalId] = useState('');
  const [external, setExternal] = useState<{ id: string; load: string; detail?: ExternalDetail }>({ id: '', load: '' });
  const dialogRead = useRef(0);
  const dialog = useRef<{ kind: string; args: Record<string, string>; scopes?: Record<string, string> } | null>(null);
  const [, changed] = useState(0);
  const [riskResults, setRiskResults] = useState<{
    projectId: string;
    cardId: string;
    risks: RiskDetectionResult[];
  } | null>(null);
  const [selection, select] = useState<string | null>(null);
  const [sop, setSop] = useState<{ id: string; load: string; value: WorkflowSop | null }>({
    id: '',
    load: 'loading',
    value: null,
  });
  const snapshot = useRef({
    items,
    featureIds,
    sopDefinition: DEVELOPMENT_SOP_DEFINITION,
    read,
    docs,
    threads: data.threads,
    projects,
    projectsLoad,
    external,
    riskResults,
    sop,
    browsing,
    dialog: dialog.current,
  });
  snapshot.current = useMemo(
    () => ({
      items,
      featureIds,
      sopDefinition: DEVELOPMENT_SOP_DEFINITION,
      read,
      docs,
      threads: data.threads,
      projects,
      projectsLoad,
      external,
      riskResults,
      sop,
      browsing,
      dialog: dialog.current,
    }),
    [
      items,
      featureIds,
      read,
      docs,
      data.threads,
      projects,
      projectsLoad,
      external,
      riskResults,
      sop,
      browsing,
      dialog.current,
    ],
  );
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    void request<{ projects: ExternalProject[] }>('/api/external-projects', { signal: abort.signal })
      .then(({ projects }) => {
        if (!abort.signal.aborted) {
          setProjects(projects);
          setProjectsLoad('');
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setProjectsLoad('error');
      });
    return () => abort.abort();
  }, [needed, generation]);
  useEffect(() => {
    if (!needed || !externalId) return;
    const project = projects.find((project) => project.id === externalId);
    if (!project) return;
    const abort = new AbortController(),
      base = `/api/external-projects/${encodeURIComponent(project.id)}`;
    setExternal((current) => (current.id === project.id ? current : { id: project.id, load: 'loading' }));
    void (async () => {
      const frameRead = async () => {
        const response = await apiFetch(base + '/frame', { signal: abort.signal });
        if (response.status === 404) return null;
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        return body.frame as NeedAuditFrame;
      };
      const [frame, cards, items, digests, resolutions, slices, patterns, riskSummary] = await Promise.all([
        frameRead(),
        request<{ cards: IntentCard[] }>(base + '/intent-cards', { signal: abort.signal }),
        request<{ items: BacklogItem[] }>(`/api/backlog/items?${new URLSearchParams({ projectId: project.id })}`, {
          signal: abort.signal,
        }),
        request<{ digests: DispatchExecutionDigest[] }>(
          `/api/execution-digests?${new URLSearchParams({ projectPath: project.sourcePath })}`,
          { signal: abort.signal },
        ),
        request<{ resolutions: ResolutionItem[] }>(base + '/resolutions', { signal: abort.signal }),
        request<{ slices: Slice[] }>(base + '/slices', { signal: abort.signal }),
        request<{ patterns: RefluxPattern[] }>(base + '/reflux-patterns', { signal: abort.signal }),
        request<ExternalDetail['riskSummary']>(base + '/risk-summary', { signal: abort.signal }),
      ]);
      if (!abort.signal.aborted)
        setExternal({
          id: project.id,
          load: '',
          detail: {
            id: project.id,
            frame,
            cards: cards.cards,
            items: items.items,
            digests: digests.digests,
            resolutions: resolutions.resolutions,
            slices: slices.slices,
            patterns: patterns.patterns,
            riskSummary,
          },
        });
    })().catch(() => {
      if (!abort.signal.aborted) setExternal({ id: project.id, load: 'error' });
    });
    return () => abort.abort();
  }, [needed, externalId, projects, generation]);
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const { items } = await request<{ items: BacklogItem[] }>('/api/backlog/items', { signal: abort.signal });
        if (!abort.signal.aborted) {
          useMissionControlStore.getState().setItems(items);
          setRead({ load: '' });
        }
      } catch {
        if (!abort.signal.aborted) setRead((s) => ({ ...s, load: 'error' }));
      }
    })();
    return () => abort.abort();
  }, [needed, generation]);
  useEffect(() => {
    if (!needed || !selection) return;
    const abort = new AbortController();
    setSop((current) => (current.id === selection ? current : { id: selection, load: 'loading', value: null }));
    void apiFetch(`/api/backlog/${encodeURIComponent(selection)}/workflow-sop`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok && response.status !== 404) throw new Error('SOP 读取失败');
        const value: WorkflowSop | null = response.status === 404 ? null : await response.json();
        if (!abort.signal.aborted) setSop({ id: selection, load: '', value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setSop({ id: selection, load: 'error', value: null });
      });
    return () => abort.abort();
  }, [needed, selection, generation]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'wsRefluxDelete') {
      const base = `/api/external-projects/${encodeURIComponent(args.projectId)}/reflux-patterns`;
      await request(base + '/' + encodeURIComponent(args.id), { method: 'DELETE' });
      const result = await request<{ patterns: RefluxPattern[] }>(base);
      setExternal((current) =>
        current.id === args.projectId && current.detail
          ? { ...current, detail: { ...current.detail, patterns: result.patterns } }
          : current,
      );
      return true;
    }
    if (name === 'boardBrowse') {
      browse(true);
      setExternalId(ui.boardV.startsWith('x:') ? ui.boardV.slice(2) : '');
      return true;
    }
    if (name === 'boardSelect') {
      select(ui.hbItem);
      return true;
    }
    if (name === 'boardDialog') {
      if (!['intent', 'triage', 'reflux', 'clarification', 'slice', 'hbSelfClaim'].includes(args.kind)) return false;
      const ticket = ++dialogRead.current;
      const scopes =
        args.kind === 'hbSelfClaim'
          ? (await request<{ scopes: Record<string, string> }>('/api/backlog/self-claim-policy')).scopes
          : undefined;
      if (ticket !== dialogRead.current) return false;
      dialog.current = { kind: args.kind, args: { ...args }, scopes };
      snapshot.current = { ...snapshot.current, dialog: dialog.current };
      changed((n) => n + 1);
      return true;
    }

    if (
      [
        'wsIntentSave',
        'wsTriageSave',
        'wsRefluxSave',
        'wsClarifySave',
        'wsSliceSave',
        'hubSliceOrder',
        'wsRiskDetect',
      ].includes(name)
    ) {
      const projectId = args.projectId,
        base = `/api/external-projects/${encodeURIComponent(projectId)}`;
      const body = args.body ? (JSON.parse(args.body) as Record<string, unknown>) : {};
      if (name === 'wsIntentSave') await write(base + '/intent-cards', body);
      if (name === 'wsTriageSave')
        await write(base + '/intent-cards/' + encodeURIComponent(args.cardId) + '/triage', body);
      if (name === 'wsRefluxSave') await write(base + '/reflux-patterns', body);
      if (name === 'wsClarifySave') {
        if (body.op === 'answer' && !String(body.answer).trim()) throw new Error('请填写回答');
        await write(
          base + '/resolutions/' + encodeURIComponent(args.id) + '/' + body.op,
          body.op === 'answer' ? { answer: body.answer } : {},
          'PATCH',
        );
      }
      if (name === 'wsSliceSave') {
        body.cardIds = String(body.cardIds)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        if (args.id) delete body.sliceType;
        else delete body.status;
        await write(
          base + '/slices' + (args.id ? '/' + encodeURIComponent(args.id) : ''),
          body,
          args.id ? 'PATCH' : 'POST',
        );
      }
      if (name === 'wsRiskDetect') {
        const result = await write<{ risks: RiskDetectionResult[] }>(
          base + '/intent-cards/' + encodeURIComponent(args.cardId) + '/detect-risks',
          {},
        );
        setRiskResults({ projectId, cardId: args.cardId, risks: result.risks });
      } else setRiskResults(null);
      if (name === 'hubSliceOrder') {
        const desired = JSON.parse(args.keys) as string[];
        const order = external
          .detail!.slices.slice()
          .sort((a, b) => a.order - b.order)
          .map((slice) => slice.id);
        if (
          desired.length !== order.length ||
          new Set(desired).size !== order.length ||
          desired.some((id) => !order.includes(id))
        )
          throw new Error('切片列表已变化，请重新读取');
        try {
          for (let i = 0; i < desired.length; i++) {
            const other = order.indexOf(desired[i]);
            if (other === i) continue;
            await write(base + '/slices/reorder', { id1: order[i], id2: order[other] }, 'PATCH');
            [order[i], order[other]] = [order[other], order[i]];
          }
        } finally {
          refresh((n) => n + 1);
        }
        return true;
      }
      refresh((n) => n + 1);
      return true;
    }
    if (name === 'hbSelfClaim' || name === 'hbReclaim') {
      const body = name === 'hbSelfClaim' ? JSON.parse(args.body) : {};
      await write(
        `/api/backlog/items/${encodeURIComponent(args.id)}/${name === 'hbSelfClaim' ? 'self-claim' : 'lease/reclaim'}`,
        body,
      );
      refresh((n) => n + 1);
      return true;
    }
    if (name === 'boardImportProject') {
      const { project } = await write<{ project: ExternalProject }>('/api/external-projects', {
        name: args.name,
        sourcePath: args.path,
        backlogPath: args.backlog,
        description: args.description,
      });
      ui.boardV = 'x:' + project.id;
      setExternalId(project.id);
    } else if (name === 'wsExtImport') {
      const project = projects.find((project) => project.id === args.n);
      if (!project) throw new Error('项目已变化，请重新读取');
      await write(`/api/external-projects/${encodeURIComponent(project.id)}/import-backlog`, {});
    } else if (name === 'boardFrameSave') {
      const project = projects.find((project) => project.id === args.id);
      if (!project) throw new Error('项目已变化，请重新读取');
      await write(`/api/external-projects/${encodeURIComponent(project.id)}/frame`, JSON.parse(args.values));
    } else if (name === 'boardCreate') {
      await write('/api/backlog/items', {
        title: args.title,
        summary: args.summary,
        priority: args.priority.toLowerCase(),
        tags: args.tags.split(/[,，\s]+/).filter(Boolean),
      });
    } else if (['hbSuggest', 'hbApprove', 'hbReject', 'hbLease'].includes(name)) {
      const item = items.find((x) => x.id === args.k);
      if (!item) throw new Error('看板项已变化，请重新读取');
      const path = `/api/backlog/items/${encodeURIComponent(item.id)}`;
      if (name === 'hbSuggest')
        await write(path + '/suggest-claim', {
          catId: args.catId,
          why: args.why,
          plan: args.plan,
          requestedPhase: useMissionControlStore.getState().selectedPhase,
        });
      if (name === 'hbApprove')
        await write(path + '/decide-claim', {
          decision: 'approve',
          threadPhase: item.suggestion?.requestedPhase ?? useMissionControlStore.getState().selectedPhase,
        });
      if (name === 'hbReject') await write(path + '/decide-claim', { decision: 'reject', note: args.note });
      if (name === 'hbLease') {
        const op = { get: 'acquire', beat: 'heartbeat', release: 'release' }[args.v];
        if (!op) throw new Error('未知的认领操作');
        const catId = item.lease?.state === 'active' ? item.lease.ownerCatId : item.suggestion?.catId;
        if (op !== 'release' && !catId) throw new Error('认领成员尚未确定');
        await write(path + '/lease/' + op, catId ? { catId } : {});
      }
    } else if (name === 'wsImportBacklog') await write('/api/backlog/import-active-features', {});
    else if (name !== 'refresh' || args.k !== 'board') return false;
    refresh((n) => n + 1);
    return true;
  };
  return {
    action,
    ownerView: neededDocs.map((id) =>
      createElement(BoardFeatureBinding, { key: id, id, generation: Number(needed), changed: docChanged }),
    ),
    replaySources: items,
    get data() {
      return snapshot.current;
    },
  };
}
