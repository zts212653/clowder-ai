'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphResult } from '@/components/memory/CollectionGraphModel';
import type { GraphQueryCandidate } from '@/components/memory/CollectionGraphQueryStates';
import { parseIndexStatus, type RebuildJobData } from '@/components/memory/IndexStatus';
import { groupHumanBrakes } from '@/components/memory/page/brake-model';
import { writeLibraryCandidate } from '@/components/memory/page/library-candidate-actions';
import type { LibraryCandidate, LibraryCollection } from '@/components/memory/page/MemoryLibrary';
import type { MaintenanceData } from '@/components/memory/page/MemoryStatus';
import type { MemorySearchData } from '@/components/memory/page/memory-search-types';
import { isRecallLedger, type RecallLedger } from '@/components/memory/page/recall-page-types';
import { useBrakes } from '@/components/memory/page/use-brakes';
import { useMemoryRead } from '@/components/memory/page/use-memory-read';
import { useMemoryRecall } from '@/components/memory/page/use-memory-recall';
import { type HomeServiceState } from '@/components/settings/service-ui-adapter';
import { recallReplyMessage } from '@/hooks/recall-reply-lookup';
import { request, write } from './owner-api';
import { recallSourceRecords } from './useRecallBindings';

export interface MemoryExploreState {
  view: string;
  win: number;
  src: string;
  who: string;
  lib: string;
  node: string;
  graphQ: string;
  rel: Record<string, boolean>;
  targets: Record<string, string>;
  curation: { enabled: boolean } | null;
  searched: string;
  type: string;
  depth: string;
  limit: number;
  brakeRange: string;
  brakeWord: string;
  brakeSel: string;
  docLimits: Record<string, number>;
}
interface Curation {
  enabled: boolean;
  modelLabel: string;
  curatorCatId: string;
  systemThreadId: string;
}
interface HarnessHealthReport {
  totalDocs: number;
  byKind: Record<string, number>;
  byAuthority: Record<string, number>;
  contradictions: { total: number; unresolved: number };
  staleReview: { warning: number; overdue: number };
  unverified: number;
  backstopRatio: number;
  compressionRatio: number;
  generatedAt: string;
}
interface LibraryHealthReport extends HarnessHealthReport {
  staleAnchors: { count: number };
  orphanEdges: { count: number };
  verificationDebt: { needsReviewCount: number; escalatedCount: number; trustedLegacyCount: number };
  searchQuality: {
    totalSearches: number;
    observedSearches: number;
    zeroHitCount: number;
    lowHitCount: number;
    identifierProbeZeroHitCount: number;
  };
  replayDrift: { available: boolean; sampleCount: number; avgSimilarity: number | null };
  knowledgeFeed: { pendingCount: number; needsReviewCount: number };
}
interface ToolUsageMetric {
  value: number | null;
  unit: string;
  sampleN: number;
  sufficient: boolean;
  threshold: number;
}
interface LibraryToolUsage {
  generatedAt: string;
  threadCount: number;
  distribution: { searchEvidence: ToolUsageMetric; graphResolve: ToolUsageMetric; listRecent: ToolUsageMetric };
  grepAfterSearchRate: ToolUsageMetric;
  candidateSelectionDistribution: ToolUsageMetric;
  listRecentAdoptionRate: ToolUsageMetric;
  nudgeFailureRate: ToolUsageMetric;
  expansionFollowupRate: ToolUsageMetric;
  recallEventStats?: {
    total: number;
    consumed: number;
    reformulated: number;
    abandoned: number;
    fellBackToGrep: number;
  };
}
interface AxisReading {
  value: number;
  maturity: 'measured' | 'estimated' | 'lower-bound' | 'no-data';
  reason: string | null;
}
type GraphResolution =
  | { status: 'graph'; graph: GraphResult }
  | { status: 'candidates'; candidates: GraphQueryCandidate[] }
  | { status: 'no_match'; message: string };

interface LibraryDocumentsPage {
  collectionId: string;
  groups: {
    kind: string;
    count: number;
    hasMore: boolean;
    documents: { anchor: string; title: string; updatedAt: string; status: string }[];
  }[];
}
interface LibraryDocumentsRead {
  pages: LibraryDocumentsPage[];
  loading: boolean;
  error: boolean;
}
export function useMemoryExploreBindings(
  ui: MemoryExploreState,
  needed: (source: string) => boolean | number = () => false,
) {
  const catalogNeeded = needed('reads.catalog'),
    servicesNeeded = needed('reads.services');
  const catalog = useMemoryRead<{ collections: LibraryCollection[]; defaultTargetCollectionId: string | null }>(
    '/api/memory/catalog',
    undefined,
    catalogNeeded,
  );
  const documentsNeeded = needed('documents');
  const [documents, setDocuments] = useState<Record<string, LibraryDocumentsRead>>({});
  useEffect(() => {
    if (!documentsNeeded || !catalog.data) return;
    const abort = new AbortController();
    for (const collection of catalog.data.collections) {
      const id = collection.id;
      if (!(id in ui.docLimits)) ui.docLimits[id] = 20;
      setDocuments((before) =>
        id in before ? before : { ...before, [id]: { pages: [], loading: true, error: false } },
      );
      void Promise.all(
        Array.from({ length: ui.docLimits[id] / 20 }, (_, page) =>
          request<LibraryDocumentsPage>(`/api/library/${encodeURIComponent(id)}/documents?offset=${page * 20}`, {
            signal: abort.signal,
          }),
        ),
      ).then(
        (pages) => {
          if (!abort.signal.aborted)
            setDocuments((before) => ({ ...before, [id]: { pages, loading: false, error: false } }));
        },
        () => {
          if (!abort.signal.aborted)
            setDocuments((before) => ({ ...before, [id]: { pages: [], loading: false, error: true } }));
        },
      );
    }
    return () => abort.abort();
  }, [documentsNeeded, catalog.data, ui.docLimits]);
  const feed = useMemoryRead<{ pending: LibraryCandidate[]; processed: LibraryCandidate[] }>(
    '/api/memory/library-feed',
    undefined,
    needed('reads.feed'),
    60_000,
  );
  const index = useMemoryRead<Parameters<typeof parseIndexStatus>[0]>(
    '/api/evidence/status',
    undefined,
    needed('reads.index'),
  );
  const indexNeeded = needed('reads.index'),
    warming = index.data?.passage_warmup_active === true;
  useEffect(() => {
    if (!indexNeeded || !warming) return;
    const timer = setInterval(() => {
      if (!document.hidden) index.retry();
    }, 3000);
    return () => clearInterval(timer);
  }, [indexNeeded, warming, index.retry]);
  const maintenance = useMemoryRead<MaintenanceData>('/api/memory/maintenance', undefined, needed('reads.maintenance'));
  const healthReport = useMemoryRead<HarnessHealthReport | LibraryHealthReport>(
    '/api/f163/health-report',
    undefined,
    needed('reads.healthReport'),
  );
  const toolUsage = useMemoryRead<LibraryToolUsage>(
    '/api/library/tool-usage-metrics',
    undefined,
    needed('reads.toolUsage'),
  );
  const curation = useMemoryRead<Curation>('/api/config/memory-curation', undefined, needed('reads.curation'));
  const flags = useMemoryRead<{ f200: { consumptionRerank: 'off' | 'shadow' | 'on' } }>(
    '/api/recall/flags',
    undefined,
    needed('reads.flags'),
  );
  const recall = useMemoryRecall(ui.win, { cat: 'pull', system: 'push' }[ui.src] ?? 'all', ui.who, needed('recall'));
  const recallData = useMemo(() => {
    const page = recall.data;
    if (!page) return { page: null, events: [] };
    return {
      page: { days: page.days, from: page.from, to: page.to, readStatus: page.readStatus, nextCursor: page.nextCursor },
      events: page.records.map(({ event, threadId, threadTitle }) => ({
        ...recallSourceRecords(
          [event],
          page.replies.filter((reply) => reply.threadId === threadId).map(recallReplyMessage),
        )[0],
        threadId,
        threadTitle,
      })),
    };
  }, [recall.data]);
  const ledger = useMemoryRead<RecallLedger>(
    `/api/memory/recall/stats?days=${ui.win}`,
    isRecallLedger,
    needed('reads.ledger'),
  );
  const axes = useMemoryRead<Record<'harmfulConsumption' | 'unmetDemandLowerBound' | 'attentionCost', AxisReading>>(
    `/api/recall/lifecycle/three-axis?days=${ui.win}`,
    undefined,
    needed('reads.axes'),
  );
  const services = useMemoryRead<{ services: HomeServiceState[] }>('/api/services', undefined, servicesNeeded);
  const brakes = useBrakes(ui.brakeRange === 'all' ? 0 : Number(ui.brakeRange), needed('brakes'));
  const brakeRows = groupHumanBrakes(brakes.events);
  const filteredBrakes = brakeRows.filter((row) => ui.brakeWord === 'all' || row.words.includes(ui.brakeWord));
  const brake = filteredBrakes.find((row) => row.key === ui.brakeSel) ?? filteredBrakes[0];
  const [brakeSource, setBrakeSource] = useState<{
    id: string;
    load: string;
    canOpen: boolean;
    threadId?: string;
    messageId?: string;
  }>({ id: '', load: '', canOpen: false });
  const [brakeAttempt, retryBrake] = useState(0);
  const [search, setSearch] = useState<{ key: string; load: string; data: MemorySearchData | null }>({
    key: '',
    load: '',
    data: null,
  });
  const [searchAttempt, retrySearch] = useState(0);
  const searchKey = JSON.stringify([ui.searched, ui.type, ui.depth, ui.limit]);
  const libraryDraft = useRef({ kind: 'project', name: '', displayName: '', root: '', sensitivity: 'internal' });
  const [libraryScan, setLibraryScan] = useState<{
    root: string;
    totalFiles: number;
    markdownFiles: number;
    secretFindings: number;
    safe: boolean;
  } | null>(null);
  const [libraryCreated, setLibraryCreated] = useState<{ id: string; status: string } | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  useEffect(() => {
    if (!catalogNeeded || !libraryBusy || !libraryCreated) return;
    const read = () => {
      if (!document.hidden) catalog.retry();
    };
    const timer = setInterval(read, 3000);
    document.addEventListener('visibilitychange', read);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [catalogNeeded, libraryBusy, libraryCreated?.id, catalog.retry]);
  useEffect(() => {
    if (
      !servicesNeeded ||
      !services.data?.services.some((service) =>
        ['installing', 'starting', 'stopping', 'uninstalling'].includes(service.status),
      )
    )
      return;
    const read = () => {
      if (!document.hidden) services.retry();
    };
    const timer = setInterval(read, 2000);
    document.addEventListener('visibilitychange', read);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [servicesNeeded, services.data, services.retry]);
  const brakeSourceNeeded = needed('brakeSource');
  useEffect(() => {
    if (!brakeSourceNeeded || !brake) return;
    const abort = new AbortController(),
      id = brake.sourceEventId;
    setBrakeSource((current) => (current.id === id ? current : { id, load: 'loading', canOpen: false }));
    void request<{ canOpen: boolean; threadId?: string; messageId?: string }>(
      `/api/memory/brakes/${encodeURIComponent(id)}/source`,
      { signal: abort.signal },
    ).then(
      (source) => {
        if (!abort.signal.aborted) setBrakeSource({ ...source, id, load: '' });
      },
      () => {
        if (!abort.signal.aborted) setBrakeSource({ id, load: 'error', canOpen: false });
      },
    );
    return () => abort.abort();
  }, [brakeSourceNeeded, brake?.sourceEventId, brakeAttempt]);
  const searchNeeded = needed('search');
  useEffect(() => {
    if (!searchNeeded || !ui.searched) return;
    const abort = new AbortController(),
      key = searchKey;
    setSearch((current) => (current.key === key ? current : { key, load: 'loading', data: null }));
    void request<MemorySearchData>(
      `/api/memory/search?${new URLSearchParams({ q: ui.searched, type: ui.type, depth: ui.depth, limit: String(ui.limit) })}`,
      { signal: abort.signal },
    ).then(
      (data) => {
        if (!abort.signal.aborted)
          setSearch({
            key,
            // a partial read still shows what was checked (not the "latest read failed" notice)
            load: data.readStatus === 'unavailable' ? 'error' : '',
            data,
          });
      },
      () => {
        if (!abort.signal.aborted) setSearch({ key, load: 'error', data: null });
      },
    );
    return () => abort.abort();
  }, [searchNeeded, searchKey, searchAttempt]);
  const [graph, setGraph] = useState<GraphResolution | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<Error | null>(null);
  const graphRequest = useRef(0);
  const [receipt, setReceipt] = useState<{
    id: string;
    status: 'approved' | 'rejected';
    materialized: { outputPath: string; reindexed: boolean } | null;
  } | null>(null);
  const [, changed] = useState(0);
  const [rebuildId, setRebuildId] = useState('');
  const [rebuildAttempt, retryRebuild] = useState(0);
  const [rebuild, setRebuild] = useState<RebuildJobData | null>(null);
  const [rebuildError, setRebuildError] = useState<Error | null>(null);
  const candidateTarget = (item: LibraryCandidate) => {
    const ordinary = item.sourceVisibility == null || ['public', 'internal'].includes(item.sourceVisibility);
    const id = ui.targets[item.id] ?? (ordinary ? catalog.data?.defaultTargetCollectionId : null);
    return catalog.data?.collections.find(
      (collection) => collection.id === id && collection.status !== 'archived' && collection.readStatus === 'ready',
    );
  };
  const refreshLibrary = () => {
    catalog.retry();
    feed.retry();
    index.retry();
    maintenance.retry();
  };
  useEffect(() => {
    if (!needed('rebuild') || !rebuildId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setRebuildError(null);
    const read = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      try {
        const job = await request<RebuildJobData>(`/api/evidence/rebuild/${encodeURIComponent(rebuildId)}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setRebuild(job);
        if (job.status === 'done' || job.status === 'error') {
          index.retry();
          maintenance.retry();
          catalog.retry();
        } else timer = setTimeout(read, 3000);
      } catch (error) {
        if (!abort.signal.aborted) setRebuildError(error as Error);
      }
    };
    void read();
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [needed('rebuild'), rebuildId, rebuildAttempt]);
  const action = async (name: string, args: Record<string, string>): Promise<boolean> => {
    if (name === 'memorySearch') {
      if (!args.q.trim()) return true;
      ui.searched = args.q.trim();
      ui.view = 'search';
      changed((n) => n + 1);
      return true;
    }
    if (name === 'cafeBrakesMore') {
      if (brakeSource.load === 'error') retryBrake((n) => n + 1);
      else if (brakes.error) brakes.retry();
      else brakes.loadMore();
      return true;
    }
    if (name === 'libraryOpen') {
      libraryDraft.current = { kind: 'project', name: '', displayName: '', root: '', sensitivity: 'internal' };
      setLibraryScan(null);
      setLibraryCreated(null);
      setLibraryError('');
      return true;
    }
    if (name === 'libraryDraft') {
      if (libraryCreated) return true;
      if (args.field === 'root' && libraryDraft.current.root !== args.v) setLibraryScan(null);
      libraryDraft.current[args.field as keyof typeof libraryDraft.current] = args.v;
      changed((n) => n + 1);
      return true;
    }
    if (name === 'libraryDocumentsMore') {
      const id = args.id,
        offset = documents[id].pages.length * 20;
      setDocuments((before) => ({ ...before, [id]: { ...before[id], loading: true, error: false } }));
      try {
        const page = await request<LibraryDocumentsPage>(
          `/api/library/${encodeURIComponent(id)}/documents?offset=${offset}`,
        );
        setDocuments((before) => ({
          ...before,
          [id]: { pages: [...before[id].pages, page], loading: false, error: false },
        }));
      } catch (error) {
        setDocuments((before) => ({ ...before, [id]: { ...before[id], loading: false, error: true } }));
        throw error;
      }
      return true;
    }
    if (name === 'libraryScan' || name === 'libraryCreate') {
      const draft = libraryDraft.current;
      if (!libraryCreated && args.root !== undefined)
        Object.assign(draft, { name: args.name, displayName: args.displayName, root: args.root });
      if (!draft.root.trim()) throw new Error('请填写资料库根目录');
      setLibraryBusy(true);
      setLibraryError('');
      try {
        if (name === 'libraryScan') {
          const root = draft.root.trim();
          setLibraryScan({
            ...(await write<Omit<NonNullable<typeof libraryScan>, 'root'>>('/api/library/bind-dry-run', { root })),
            root,
          });
        } else {
          if (!draft.name.trim() || !libraryScan?.safe || libraryScan.root !== draft.root.trim())
            throw new Error('请完成资料库名称和安全扫描');
          const id = `${draft.kind}:${draft.name.trim()}`;
          if (!libraryCreated) {
            const result = await write<{ manifest: { id: string; status: string } }>('/api/library/register', {
              id,
              kind: draft.kind,
              name: draft.name.trim(),
              displayName: draft.displayName.trim() || draft.name.trim(),
              root: draft.root.trim(),
              sensitivity: draft.sensitivity,
            });
            setLibraryCreated(result.manifest);
            catalog.retry();
          }
          const result = await write<{ blocked: boolean }>('/api/library/' + encodeURIComponent(id) + '/rebuild', {});
          const { collections } = await request<{ collections: LibraryCollection[] }>('/api/memory/catalog');
          const collection = collections.find((collection) => collection.id === id)!;
          setLibraryCreated({ id, status: collection.status });
          refreshLibrary();
          if (result.blocked) throw new Error('资料库索引被风险检查阻止');
        }
      } catch (error) {
        setLibraryError((error as Error).message);
        throw error;
      } finally {
        setLibraryBusy(false);
      }
      return true;
    }
    if (name === 'cafeSvc') {
      const service = services.data!.services.find((service) => service.id === args.id);
      if (!service) throw new Error('服务已变化，请重新读取');
      try {
        const result = await write<{ ok: boolean; error?: string; output?: string }>(
          `/api/services/${encodeURIComponent(service.id)}/${args.op}`,
          args.op === 'reconfigure'
            ? { ...(args.port ? { port: Number(args.port) } : {}), ...(args.model ? { model: args.model } : {}) }
            : {},
        );
        if (!result.ok) throw new Error([result.error, result.output].filter(Boolean).join('\n'));
      } finally {
        services.retry();
      }
      return true;
    }
    if (name === 'memoryRecallMore') {
      await recall.loadMore();
      return true;
    }
    const searchNode =
      name === 'memoryGraphNode'
        ? search.data?.groups
            .flatMap((group) => group.results)
            .find((row) => row.graph && JSON.stringify([row.graph.collection, row.graph.anchor]) === ui.node)?.graph
        : null;
    if (name === 'memoryGraph' || (name === 'memoryGraphNode' && (searchNode || graph?.status === 'candidates'))) {
      const candidate = searchNode
        ? { collectionId: searchNode.collection, anchor: searchNode.anchor }
        : name === 'memoryGraphNode' && graph?.status === 'candidates'
          ? graph.candidates.find((node) => JSON.stringify([node.collectionId, node.anchor]) === ui.node)
          : undefined;
      if (name === 'memoryGraphNode' && !candidate) throw new Error('图谱节点已变化');
      const query = name === 'memoryGraph' ? args.q.trim() : ui.graphQ;
      if (name === 'memoryGraph' && !query) return true;
      ui.graphQ = query;
      const ticket = ++graphRequest.current;
      setGraph(null);
      setGraphLoading(true);
      setGraphError(null);
      try {
        const result: GraphResolution = candidate
          ? {
              status: 'graph',
              graph: await request<GraphResult>(
                `/api/library/graph?${new URLSearchParams({ anchor: candidate.anchor, collection: candidate.collectionId, depth: '1' })}`,
              ),
            }
          : await request<GraphResolution>(`/api/library/graph/resolve?${new URLSearchParams({ query, depth: '1' })}`);
        if (ticket === graphRequest.current) {
          if (result.status === 'graph') {
            ui.node = result.graph.center ?? candidate?.anchor ?? '';
            ui.rel = Object.fromEntries(result.graph.edges.map((edge) => [edge.relation, true]));
          }
          setGraph(result);
        }
      } catch (error) {
        if (ticket === graphRequest.current) setGraphError(error as Error);
        throw error;
      } finally {
        if (ticket === graphRequest.current) setGraphLoading(false);
      }
      return true;
    }
    if (name === 'memoryGraphNode') {
      changed((n) => n + 1);
      return true;
    }
    if (name === 'memoryLibraryTarget') {
      ui.targets[args.id] = args.v;
      changed((n) => n + 1);
      return true;
    }
    if (name === 'memoryLibraryDecide') {
      const item = feed.data?.pending.find((item) => item.id === args.id);
      if (!item) throw new Error('待收录内容已变化');
      const target = candidateTarget(item);
      const op = args.v === '1' ? 'approve' : 'reject';
      if (op === 'approve' && !target) throw new Error('请选择可读取的资料库');
      let result = await writeLibraryCandidate(op, item.id, target, false);
      if (result.kind === 'confirm') {
        if (
          !(await window.clowderChat.confirm('memoryWiden', {
            source: item.sourceVisibility,
            target: target!.visibility,
          }))
        )
          return true;
        result = await writeLibraryCandidate(op, item.id, target, true);
      }
      if (result.kind !== 'done') throw new Error(result.kind === 'blocked' ? result.message : '收录结果尚未确认');
      setReceipt({ id: item.id, status: result.status, materialized: result.materialized });
      refreshLibrary();
      return true;
    }
    if (name === 'cafeCandUndo') {
      await write('/api/knowledge/undo', { markerId: args.id });
      refreshLibrary();
      return true;
    }
    if (name === 'memoryCollection') {
      const collection = catalog.data?.collections.find((collection) => collection.id === args.id);
      if (!collection) throw new Error('资料库已变化');
      const op = args.op === 'archive' ? (collection.status === 'archived' ? 'unarchive' : 'archive') : 'rebuild';
      const result = await write<{ blocked?: boolean; reason?: string }>(
        `/api/library/${encodeURIComponent(collection.id)}/${op}`,
        {},
      );
      if (result.blocked) throw new Error(result.reason);
      refreshLibrary();
      return true;
    }
    if (name === 'memoryCuration') {
      await write('/api/config/memory-curation', { enabled: args.v }, 'PUT');
      curation.retry();
      return true;
    }
    if (name === 'cafeMemRebuild') {
      const { taskId } = await write<{ taskId: string }>('/api/evidence/rebuild', {});
      setRebuildId(taskId);
      setRebuild(null);
      return true;
    }
    if (name === 'cafeMemWarm') {
      await write('/api/evidence/warmup', {});
      index.retry();
      return true;
    }
    if (
      (name === 'refresh' && ['mem-lib', 'mem-status', 'mem-health'].includes(args.k)) ||
      name === 'memoryExploreRetry'
    ) {
      refreshLibrary();
      curation.retry();
      flags.retry();
      services.retry();
      healthReport.retry();
      toolUsage.retry();
      recall.retry();
      ledger.retry();
      axes.retry();
      retryRebuild((n) => n + 1);
      return true;
    }
    if (name === 'cafeMemRetry' && ui.view !== 'all') {
      if (ui.view === 'brakes') {
        brakes.retry();
        retryBrake((n) => n + 1);
        return true;
      }
      if (ui.view === 'search') {
        retrySearch((n) => n + 1);
        return true;
      }
      if (ui.view === 'graph') return action('memoryGraph', { q: ui.graphQ });
      if (ui.view === 'library' || ui.view === 'status') return action('memoryExploreRetry', {});
      recall.retry();
      ledger.retry();
      axes.retry();
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({
      documents,
      reads: Object.fromEntries(
        Object.entries({
          catalog,
          feed,
          index,
          maintenance,
          healthReport,
          toolUsage,
          curation,
          flags,
          ledger,
          axes,
          services,
        }).map(([name, { data, loading, error }]) => [name, { data, loading, error }]),
      ),
      recall: {
        ...recallData,
        loading: recall.loading,
        error: recall.error,
        moreLoading: recall.moreLoading,
        moreError: recall.moreError,
      },
      brakes: { events: brakes.events, loading: brakes.loading, error: brakes.error, hasMore: brakes.hasMore },
      brakeSource,
      search,
      libraryScan,
      libraryCreated,
      libraryBusy,
      libraryError,
      graph,
      graphLoading,
      graphError,
      receipt,
      rebuild,
      rebuildError,
    }),
    [
      documents,
      catalog.data,
      catalog.loading,
      catalog.error,
      feed.data,
      feed.loading,
      feed.error,
      index.data,
      index.loading,
      index.error,
      maintenance.data,
      maintenance.loading,
      maintenance.error,
      healthReport.data,
      healthReport.loading,
      healthReport.error,
      toolUsage.data,
      toolUsage.loading,
      toolUsage.error,
      curation.data,
      curation.loading,
      curation.error,
      flags.data,
      flags.loading,
      flags.error,
      ledger.data,
      ledger.loading,
      ledger.error,
      axes.data,
      axes.loading,
      axes.error,
      services.data,
      services.loading,
      services.error,
      recallData,
      recall.loading,
      recall.error,
      recall.moreLoading,
      recall.moreError,
      brakes.events,
      brakes.loading,
      brakes.error,
      brakes.hasMore,
      brakeSource,
      search,
      libraryScan,
      libraryCreated,
      libraryBusy,
      libraryError,
      graph,
      graphLoading,
      graphError,
      receipt,
      rebuild,
      rebuildError,
    ],
  );
  return {
    draft: libraryDraft,
    action,

    data: rawData,
  };
}
