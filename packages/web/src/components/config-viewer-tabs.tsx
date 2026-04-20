import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type CatData, saveCatOrder } from '@/hooks/useCatData';
import { sortCatsByOrder } from '@/lib/sort-cats-by-order';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import { DefaultCatSelector } from './DefaultCatSelector';
import { HubCoCreatorOverviewCard, HubMemberOverviewCard, HubOverviewToolbar } from './HubMemberOverviewCard';

/** Move srcId to the position of targetId within ids. Returns a new array. */
function reorderIds(ids: string[], srcId: string, targetId: string): string[] {
  const withoutSrc = ids.filter((id) => id !== srcId);
  const targetIdx = withoutSrc.indexOf(targetId);
  if (targetIdx < 0) return ids;
  return [...withoutSrc.slice(0, targetIdx), srcId, ...withoutSrc.slice(targetIdx)];
}

export type { Capabilities, CatConfig, ConfigData, ContextBudget } from './config-viewer-types';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <h3 className="text-xs font-semibold text-cafe-secondary mb-2">{title}</h3>
      {children}
    </section>
  );
}

function KV({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  return (
    <div className="flex justify-between text-xs text-cafe-secondary">
      <span>{label}</span>
      <span className="font-medium text-right">{display}</span>
    </div>
  );
}

/** Screen 2 summary overview — co-creator card plus member cards */
export function CatOverviewTab({
  config,
  cats,
  onAddMember,
  onEditCoCreator,
  onEditMember,
  onToggleAvailability,
  togglingCatId,
}: {
  config: ConfigData;
  cats: CatData[];
  onAddMember?: () => void;
  onEditCoCreator?: () => void;
  onEditMember?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  togglingCatId?: string | null;
}) {
  // F154 Phase B (AC-B2): Fetch and manage global default cat
  const [defaultCatId, setDefaultCatId] = useState<string | null>(null);
  const [defaultCatLoading, setDefaultCatLoading] = useState(false);
  const [defaultCatFetchError, setDefaultCatFetchError] = useState(false);
  const [defaultCatSaveError, setDefaultCatSaveError] = useState<string | null>(null);

  // F166: Local optimistic cat order; null = follow props. Re-sorted against incoming cats.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const saveSeqRef = useRef(0);

  const displayCats = useMemo(() => (localOrder ? sortCatsByOrder(cats, localOrder) : cats), [cats, localOrder]);

  const handleDragStart = useCallback((cat: CatData, event: ReactDragEvent<HTMLElement>) => {
    draggingIdRef.current = cat.id;
    setDraggingId(cat.id);
    event.dataTransfer?.setData('text/plain', cat.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((_cat: CatData, event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnd = useCallback(() => {
    draggingIdRef.current = null;
    setDraggingId(null);
  }, []);

  const handleDrop = useCallback(
    async (target: CatData, event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const srcId = draggingIdRef.current ?? event.dataTransfer?.getData('text/plain') ?? '';
      draggingIdRef.current = null;
      setDraggingId(null);
      if (!srcId || srcId === target.id) return;
      const currentIds = displayCats.map((c) => c.id);
      const nextOrder = reorderIds(currentIds, srcId, target.id);
      if (nextOrder.length === 0) return;
      const previous = localOrder;
      const mySeq = ++saveSeqRef.current;
      setLocalOrder(nextOrder);
      setDragError(null);
      try {
        await saveCatOrder(nextOrder);
      } catch {
        if (saveSeqRef.current === mySeq) {
          setLocalOrder(previous);
          setDragError('排序保存失败，请重试');
        }
      }
    },
    [displayCats, localOrder],
  );

  const fetchDefaultCat = useCallback(() => {
    setDefaultCatFetchError(false);
    apiFetch('/api/config/default-cat')
      .then((r) => r.json())
      .then((data: { catId: string }) => setDefaultCatId(data.catId))
      .catch(() => setDefaultCatFetchError(true));
  }, []);

  useEffect(() => {
    fetchDefaultCat();
  }, [fetchDefaultCat]);

  const handleDefaultCatSelect = useCallback(
    async (catId: string) => {
      if (catId === defaultCatId) return;
      setDefaultCatLoading(true);
      setDefaultCatSaveError(null);
      try {
        const res = await apiFetch('/api/config/default-cat', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ catId }),
        });
        if (res.ok) {
          setDefaultCatId(catId);
        } else {
          setDefaultCatSaveError('保存失败，请重试');
        }
      } catch {
        setDefaultCatSaveError('网络错误，请重试');
      } finally {
        setDefaultCatLoading(false);
      }
    },
    [defaultCatId],
  );

  return (
    <div className="space-y-4">
      <HubOverviewToolbar onAddMember={onAddMember} />
      {/* F154 Phase B: Global default cat selector (AC-B2: always visible, even on error) */}
      <DefaultCatSelector
        cats={cats}
        currentDefaultCatId={defaultCatId ?? ''}
        onSelect={handleDefaultCatSelect}
        isLoading={defaultCatLoading}
        fetchError={defaultCatFetchError}
        saveError={defaultCatSaveError}
        onRetry={fetchDefaultCat}
      />
      {config.coCreator ? <HubCoCreatorOverviewCard coCreator={config.coCreator} onEdit={onEditCoCreator} /> : null}
      {dragError ? (
        <p className="text-[13px] text-[#C14E4E]" role="alert">
          {dragError}
        </p>
      ) : null}
      <div className="space-y-3">
        {displayCats.map((catData, idx) => (
          <HubMemberOverviewCard
            key={catData.id}
            cat={catData}
            configCat={config.cats[catData.id]}
            onEdit={onEditMember}
            onToggleAvailability={onToggleAvailability}
            togglingAvailability={togglingCatId === catData.id}
            guideTargetId={idx === 0 ? 'cats.first-member' : undefined}
            draggable
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            isDragging={draggingId === catData.id}
          />
        ))}
      </div>
      <p className="text-[13px] text-[#B59A88]">按住 ⠿ 拖动卡片可自由排序；点击卡片进入成员配置 →</p>
      {cats.length === 0 && <p className="text-sm text-cafe-muted">未找到成员配置数据</p>}
    </div>
  );
}

type BubbleDefault = 'expanded' | 'collapsed';

function BubbleToggle({
  label,
  value,
  configKey,
  onChanged,
}: {
  label: string;
  value: BubbleDefault;
  configKey: string;
  onChanged: () => void;
}) {
  const pendingRef = useRef(false);
  const [optimistic, setOptimistic] = useState<BubbleDefault | null>(null);
  const display = optimistic ?? value;

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const next: BubbleDefault = display === 'collapsed' ? 'expanded' : 'collapsed';
    setOptimistic(next);
    try {
      const res = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey, value: next }),
      });
      if (res.ok) {
        setOptimistic(null);
        onChanged();
        void useChatStore.getState().fetchGlobalBubbleDefaults();
      } else setOptimistic(null);
    } catch {
      setOptimistic(null);
    } finally {
      pendingRef.current = false;
    }
  }, [display, configKey, onChanged]);

  return (
    <div className="flex items-center justify-between text-xs text-cafe-secondary">
      <span>{label}</span>
      <button
        onClick={toggle}
        className="text-[11px] px-2 py-0.5 rounded-full border border-cafe hover:border-gray-400 hover:bg-cafe-surface-elevated transition-colors"
      >
        {display === 'expanded' ? '展开' : '折叠'}
      </button>
    </div>
  );
}

export function SystemTab({ config, onConfigChange }: { config: ConfigData; onConfigChange?: () => void }) {
  const handleChanged = useCallback(() => onConfigChange?.(), [onConfigChange]);

  return (
    <>
      <Section title="气泡显示">
        <div className="space-y-1.5">
          <BubbleToggle
            label="Thinking 默认"
            value={config.ui?.bubbleDefaults?.thinking ?? 'collapsed'}
            configKey="ui.bubble.thinking"
            onChanged={handleChanged}
          />
          <BubbleToggle
            label="CLI 气泡默认"
            value={config.ui?.bubbleDefaults?.cliOutput ?? 'collapsed'}
            configKey="ui.bubble.cliOutput"
            onChanged={handleChanged}
          />
        </div>
      </Section>
      <Section title="A2A 猫猫互调">
        <div className="space-y-1.5">
          <KV label="启用" value={config.a2a.enabled} />
          <KV label="最大深度" value={config.a2a.maxDepth} />
        </div>
      </Section>
      <Section title="记忆 (F3-lite)">
        <div className="space-y-1.5">
          <KV label="启用" value={config.memory.enabled} />
          <KV label="每线程最大 key 数" value={config.memory.maxKeysPerThread} />
        </div>
      </Section>
      {config.codexExecution ? (
        <Section title="Codex 推理执行">
          <div className="space-y-1.5">
            <KV label="Model" value={config.codexExecution.model} />
            <KV label="Auth Mode" value={config.codexExecution.authMode} />
            <KV label="Pass --model Arg" value={config.codexExecution.passModelArg} />
          </div>
        </Section>
      ) : null}
      <Section title="治理 & 降级">
        <div className="space-y-1.5">
          <KV label="降级策略启用" value={config.governance.degradationEnabled} />
          <KV label="Done 超时" value={`${config.governance.doneTimeoutMs / 1000}s`} />
          <KV label="Heartbeat 间隔" value={`${config.governance.heartbeatIntervalMs / 1000}s`} />
        </div>
      </Section>
    </>
  );
}
