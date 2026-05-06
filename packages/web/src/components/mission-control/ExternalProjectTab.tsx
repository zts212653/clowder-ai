'use client';

import type {
  BacklogItem,
  DispatchExecutionDigest,
  ExternalProject,
  IntentCard,
  NeedAuditFrame as NeedAuditFrameType,
  RefluxPattern,
  ResolutionItem,
  Slice,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';
import { CreateIntentCardForm } from './CreateIntentCardForm';
import { DispatchProgress } from './DispatchProgress';
import { GovernanceHealth } from './GovernanceHealth';
import { IntentCardDetail } from './IntentCardDetail';
import { NeedAuditFrame } from './NeedAuditFrame';
import { RefluxCapture } from './RefluxCapture';
import { ResolutionQueue } from './ResolutionQueue';
import { RiskPanel } from './RiskPanel';
import { SliceLadder } from './SliceLadder';
import { TranslationMatrix } from './TranslationMatrix';

type SubTab = 'features' | 'audit' | 'health' | 'progress' | 'risk' | 'resolutions' | 'slices' | 'reflux';

interface ExternalProjectTabProps {
  project: ExternalProject;
}

export function ExternalProjectTab({ project }: ExternalProjectTabProps) {
  const {
    intentCards,
    auditFrame,
    executionDigests,
    resolutions,
    slices,
    refluxPatterns,
    setIntentCards,
    setAuditFrame,
    setExecutionDigests,
    setResolutions,
    setSlices,
    setRefluxPatterns,
    setLoading,
  } = useExternalProjectStore();
  const [subTab, setSubTab] = useState<SubTab>('audit');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [projectItems, setProjectItems] = useState<BacklogItem[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  // Data is stale when it belongs to a different project than the one we're viewing
  const isStale = loadedProjectId !== project.id;

  // Sync inert attribute with stale state — pointer-events-none blocks mouse
  // interactions but not keyboard/focus; inert blocks everything.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (isStale) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [isStale]);

  // Load all data for the active project — stale-while-revalidate:
  // keep old project data visible until the new project's data arrives.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const [cardsRes, frameRes, itemsRes, digestsRes, resRes, slicesRes, refluxRes] = await Promise.allSettled([
        apiFetch(`/api/external-projects/${project.id}/intent-cards`),
        apiFetch(`/api/external-projects/${project.id}/frame`),
        apiFetch(`/api/backlog/items?projectId=${project.id}`),
        apiFetch(`/api/execution-digests?projectPath=${encodeURIComponent(project.sourcePath)}`),
        apiFetch(`/api/external-projects/${project.id}/resolutions`),
        apiFetch(`/api/external-projects/${project.id}/slices`),
        apiFetch(`/api/external-projects/${project.id}/reflux-patterns`),
      ]);
      if (cancelled) return;

      // Per-source clearing: on failure, clear that data source so no
      // stale data from the previous project survives a partial success.
      if (cardsRes.status === 'fulfilled' && cardsRes.value.ok) {
        const body = (await cardsRes.value.json()) as { cards: IntentCard[] };
        if (!cancelled) setIntentCards(body.cards);
      } else if (!cancelled) {
        setIntentCards([]);
      }
      if (frameRes.status === 'fulfilled' && frameRes.value.ok) {
        const body = (await frameRes.value.json()) as { frame: NeedAuditFrameType };
        if (!cancelled) setAuditFrame(body.frame);
      } else if (!cancelled) {
        setAuditFrame(null);
      }
      if (itemsRes.status === 'fulfilled' && itemsRes.value.ok) {
        const body = (await itemsRes.value.json()) as { items: BacklogItem[] };
        if (!cancelled) setProjectItems(body.items);
      } else if (!cancelled) {
        setProjectItems([]);
      }
      if (digestsRes.status === 'fulfilled' && digestsRes.value.ok) {
        const body = (await digestsRes.value.json()) as { digests: DispatchExecutionDigest[] };
        if (!cancelled) setExecutionDigests(body.digests);
      } else if (!cancelled) {
        setExecutionDigests([]);
      }
      if (resRes.status === 'fulfilled' && resRes.value.ok) {
        const body = (await resRes.value.json()) as { resolutions: ResolutionItem[] };
        if (!cancelled) setResolutions(body.resolutions);
      } else if (!cancelled) {
        setResolutions([]);
      }
      if (slicesRes.status === 'fulfilled' && slicesRes.value.ok) {
        const body = (await slicesRes.value.json()) as { slices: Slice[] };
        if (!cancelled) setSlices(body.slices);
      } else if (!cancelled) {
        setSlices([]);
      }
      if (refluxRes.status === 'fulfilled' && refluxRes.value.ok) {
        const body = (await refluxRes.value.json()) as { patterns: RefluxPattern[] };
        if (!cancelled) setRefluxPatterns(body.patterns);
      } else if (!cancelled) {
        setRefluxPatterns([]);
      }
      if (!cancelled) {
        setLoadedProjectId(project.id);
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    project.id,
    setIntentCards,
    setAuditFrame,
    setExecutionDigests,
    setResolutions,
    setSlices,
    setRefluxPatterns,
    setLoading,
    project.sourcePath,
  ]);

  const reloadProjectItems = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/backlog/items?projectId=${project.id}`);
      if (res.ok) {
        const body = (await res.json()) as { items: BacklogItem[] };
        setProjectItems(body.items);
      }
    } catch {
      /* ignore */
    }
  }, [project.id]);

  const handleImportBacklog = useCallback(async () => {
    setImportStatus('导入中...');
    try {
      const res = await apiFetch(`/api/external-projects/${project.id}/import-backlog`, { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as { imported: number; skipped: number; total: number; orphans?: number };
        const orphanStatus = body.orphans ? `，检测到 ${body.orphans} 个历史未绑定项；项目内条目已可见` : '';
        setImportStatus(`导入完成: ${body.imported} 新增, ${body.skipped} 跳过, ${body.total} 总计${orphanStatus}`);
        void reloadProjectItems();
      } else {
        const body = (await res.json()) as { error?: string };
        setImportStatus(`导入失败: ${body.error ?? res.status}`);
      }
    } catch {
      setImportStatus('导入失败');
    }
  }, [project.id, reloadProjectItems]);

  const selectedCard = useMemo(
    () => intentCards.find((c) => c.id === selectedCardId) ?? null,
    [intentCards, selectedCardId],
  );

  const handleCardCreated = useCallback(
    (card: IntentCard) => {
      setIntentCards([card, ...intentCards]);
      setShowCreateForm(false);
      setSelectedCardId(card.id);
    },
    [intentCards, setIntentCards],
  );

  const handleCardTriaged = useCallback(
    (updated: IntentCard) => {
      setIntentCards(intentCards.map((c) => (c.id === updated.id ? updated : c)));
    },
    [intentCards, setIntentCards],
  );

  const loadData = useCallback(async () => {
    const [resRes, slicesRes, refluxRes] = await Promise.allSettled([
      apiFetch(`/api/external-projects/${project.id}/resolutions`),
      apiFetch(`/api/external-projects/${project.id}/slices`),
      apiFetch(`/api/external-projects/${project.id}/reflux-patterns`),
    ]);
    if (resRes.status === 'fulfilled' && resRes.value.ok) {
      const body = (await resRes.value.json()) as { resolutions: ResolutionItem[] };
      setResolutions(body.resolutions);
    }
    if (slicesRes.status === 'fulfilled' && slicesRes.value.ok) {
      const body = (await slicesRes.value.json()) as { slices: Slice[] };
      setSlices(body.slices);
    }
    if (refluxRes.status === 'fulfilled' && refluxRes.value.ok) {
      const body = (await refluxRes.value.json()) as { patterns: RefluxPattern[] };
      setRefluxPatterns(body.patterns);
    }
  }, [project.id, setResolutions, setSlices, setRefluxPatterns]);

  const SUB_TABS: { id: SubTab; label: string }[] = [
    { id: 'audit', label: '需求追踪' },
    { id: 'health', label: '治理健康度' },
    { id: 'features', label: '功能列表' },
    { id: 'progress', label: '派遣进展' },
    { id: 'risk', label: '風險預警' },
    { id: 'resolutions', label: '澄清队列' },
    { id: 'slices', label: '切片計劃' },
    { id: 'reflux', label: '经验回流' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sub-header */}
      <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-6 py-2">
        <div className="flex gap-1">
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                subTab === t.id
                  ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                  : 'bg-[var(--console-pill-bg)] text-cafe-secondary hover:bg-[var(--console-pill-bg)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {importStatus && <span className="text-[10px] text-cafe-muted">{importStatus}</span>}
          <button
            type="button"
            onClick={() => void handleImportBacklog()}
            disabled={isStale}
            className="console-button-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            导入 Backlog
          </button>
        </div>
      </div>

      {/* Stale barrier: show refreshing indicator and block interactions until fresh data arrives */}
      {isStale && (
        <div className="px-6 py-1 text-center text-[10px] text-cafe-muted animate-pulse">
          Refreshing project data...
        </div>
      )}

      {/* Content — inert when stale blocks ALL interaction (mouse + keyboard + focus) to prevent cross-project writes */}
      <div ref={contentRef} className={`min-h-0 flex-1 overflow-auto ${isStale ? 'opacity-60' : ''}`}>
        <div className="grid min-h-0 grid-cols-1 gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          {/* Left column */}
          <div className="space-y-4">
            {/* Stage 0 Frame prompt */}
            {!auditFrame && subTab === 'audit' && (
              <div className="rounded-lg border-2 border-dashed border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 text-center">
                <div className="text-sm font-medium text-cafe-secondary">Stage 0: Frame 尚未完成</div>
                <div className="mt-1 text-xs text-cafe-muted">建议先完成六问定位，再开始需求翻译</div>
              </div>
            )}

            {subTab === 'audit' &&
              (showCreateForm ? (
                <CreateIntentCardForm
                  projectId={project.id}
                  onCreated={handleCardCreated}
                  onCancel={() => setShowCreateForm(false)}
                />
              ) : (
                <TranslationMatrix
                  cards={intentCards}
                  selectedCardId={selectedCardId}
                  onSelectCard={setSelectedCardId}
                  onCreateCard={() => setShowCreateForm(true)}
                />
              ))}

            {subTab === 'health' && (
              <GovernanceHealth
                cards={intentCards}
                digests={executionDigests}
                resolutions={resolutions}
                slices={slices}
              />
            )}

            {subTab === 'progress' && <DispatchProgress digests={executionDigests} />}

            {subTab === 'risk' && <RiskPanel projectId={project.id} cards={intentCards} />}

            {subTab === 'resolutions' && (
              <ResolutionQueue
                projectId={project.id}
                resolutions={resolutions}
                cards={intentCards}
                onUpdate={() => void loadData()}
              />
            )}

            {subTab === 'slices' && (
              <SliceLadder projectId={project.id} slices={slices} onUpdate={() => void loadData()} />
            )}

            {subTab === 'reflux' && (
              <RefluxCapture projectId={project.id} patterns={refluxPatterns} onUpdate={() => void loadData()} />
            )}

            {subTab === 'features' &&
              (projectItems.length === 0 ? (
                <div className="rounded-lg bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] p-8 text-center text-sm text-cafe-muted">
                  暂无功能 — 使用上方「导入 Backlog」按钮从项目导入
                </div>
              ) : (
                <div className="space-y-2">
                  {projectItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-lg bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span className="rounded bg-[var(--console-pill-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--cafe-accent)]">
                          {item.tags[0] ?? '—'}
                        </span>
                        <span className="text-sm font-medium text-cafe">{item.title}</span>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          item.status === 'done'
                            ? 'bg-conn-emerald-bg text-conn-emerald-text'
                            : item.status === 'dispatched'
                              ? 'bg-[var(--color-cafe-accent)]/10 text-[var(--color-cafe-accent)]'
                              : 'bg-[var(--console-pill-bg)] text-[var(--cafe-accent)]'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
          </div>

          {/* Right panel */}
          <div className="space-y-4">
            <NeedAuditFrame projectId={project.id} frame={auditFrame} onSaved={(frame) => setAuditFrame(frame)} />
            {selectedCard && subTab === 'audit' && (
              <IntentCardDetail card={selectedCard} onTriaged={handleCardTriaged} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
