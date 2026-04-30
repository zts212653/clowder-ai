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
import { HubMemberOverviewCard } from './HubMemberOverviewCard';
import { HubIcon } from './hub-icons';

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
    <section className="rounded-xl bg-[var(--console-card-bg)] p-4 md:p-5">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">{title}</h3>
      {children}
    </section>
  );
}

function KV({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  return (
    <div className="flex justify-between border-b border-[var(--console-border-soft)] py-2 text-xs text-cafe-secondary last:border-b-0">
      <span>{label}</span>
      <span className="font-medium text-right">{display}</span>
    </div>
  );
}

export function CatOverviewTab({
  config,
  cats,
  onAddMember,
  onEditMember,
  onEditCoCreator,
  onDeleteMember,
  onToggleAvailability,
  togglingCatId,
}: {
  config: ConfigData;
  cats: CatData[];
  onAddMember?: () => void;
  onEditMember?: (cat: CatData) => void;
  onEditCoCreator?: () => void;
  onDeleteMember?: (cat: CatData) => void;
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

  const allDisplayCats = useMemo(() => (localOrder ? sortCatsByOrder(cats, localOrder) : cats), [cats, localOrder]);
  const displayCats = useMemo(() => allDisplayCats.filter((c) => c.roster?.available !== false), [allDisplayCats]);
  const disabledCats = useMemo(() => allDisplayCats.filter((c) => c.roster?.available === false), [allDisplayCats]);

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
      const currentIds = allDisplayCats.map((c) => c.id);
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
    [allDisplayCats, localOrder],
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
          const data = (await res.json()) as { warning?: string };
          setDefaultCatId(catId);
          if (data.warning) setDefaultCatSaveError(data.warning);
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
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onAddMember}
          className="flex h-9 items-center gap-2 rounded-lg bg-[var(--cafe-accent)] px-3.5 text-[13px] font-semibold text-[var(--cafe-accent-foreground)] transition-opacity hover:opacity-90"
          data-bootcamp-step="add-member-button"
          data-guide-id="cats.add-member"
        >
          <HubIcon name="plus" className="h-[15px] w-[15px]" />
          添加成员
        </button>
      </div>

      <DefaultCatSelector
        cats={cats.filter((c) => c.roster?.available !== false)}
        currentDefaultCatId={defaultCatId ?? ''}
        onSelect={handleDefaultCatSelect}
        isLoading={defaultCatLoading}
        fetchError={defaultCatFetchError}
        saveError={defaultCatSaveError}
        onRetry={fetchDefaultCat}
      />

      {dragError ? (
        <p className="text-[13px]" role="alert" style={{ color: 'var(--notice-error-label)' }}>
          {dragError}
        </p>
      ) : null}

      <div className="flex flex-col gap-3.5">
        {config.coCreator && (
          <section
            data-testid="owner-card"
            onClick={() => onEditCoCreator?.()}
            className="flex h-24 cursor-pointer items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]"
          >
            {config.coCreator.avatar ? (
              <img
                src={config.coCreator.avatar}
                alt={config.coCreator.name}
                className="h-9 w-9 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-[var(--cafe-accent-foreground)]"
                style={{ backgroundColor: config.coCreator.color?.primary ?? 'var(--cafe-accent)' }}
              >
                {config.coCreator.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-cafe">{config.coCreator.name}</p>
              <p className="mt-1 text-[12px] text-cafe-secondary">
                铲屎官 / CVO
                {(() => {
                  const handles =
                    config.coCreator!.aliases?.length > 0
                      ? config.coCreator!.aliases
                      : config.coCreator!.mentionPatterns?.filter((p) => p.startsWith('@'));
                  return handles?.length > 0 ? <span className="text-cafe-muted"> · {handles.join(' ')}</span> : null;
                })()}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-[var(--console-pill-bg)] px-2.5 py-0.5 text-[11px] text-cafe-muted">
              Owner
            </span>
          </section>
        )}
        {displayCats.map((catData, idx) => (
          <HubMemberOverviewCard
            key={catData.id}
            cat={catData}
            configCat={config.cats[catData.id]}
            onEdit={onEditMember}
            onDelete={onDeleteMember}
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
      {cats.length === 0 && <p className="text-sm text-cafe-muted">未找到成员配置数据</p>}
      {disabledCats.length > 0 && (
        <div className="space-y-3">
          <p className="text-[12px] font-semibold text-slate-400 uppercase tracking-wide">已停用成员</p>
          {disabledCats.map((catData) => (
            <HubMemberOverviewCard
              key={catData.id}
              cat={catData}
              configCat={config.cats[catData.id]}
              onEdit={onEditMember}
              onDelete={onDeleteMember}
              onToggleAvailability={onToggleAvailability}
              togglingAvailability={togglingCatId === catData.id}
            />
          ))}
        </div>
      )}
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
    <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] py-2 text-xs text-cafe-secondary last:border-b-0">
      <span>{label}</span>
      <button
        onClick={toggle}
        className="console-pill rounded-full px-3 py-1 text-[11px] transition-colors hover:text-cafe"
      >
        {display === 'expanded' ? '展开' : '折叠'}
      </button>
    </div>
  );
}

export function SystemTab({ config, onConfigChange }: { config: ConfigData; onConfigChange?: () => void }) {
  const handleChanged = useCallback(() => onConfigChange?.(), [onConfigChange]);

  return (
    <div className="space-y-6">
      <Section title="气泡显示">
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
      </Section>
      <Section title="A2A 猫猫互调">
        <KV label="启用" value={config.a2a.enabled} />
        <KV label="最大深度" value={config.a2a.maxDepth} />
      </Section>
      <Section title="记忆 (F3-lite)">
        <KV label="启用" value={config.memory.enabled} />
        <KV label="每线程最大 key 数" value={config.memory.maxKeysPerThread} />
      </Section>
      {config.codexExecution ? (
        <Section title="Codex 推理执行">
          <KV label="Model" value={config.codexExecution.model} />
          <KV label="Auth Mode" value={config.codexExecution.authMode} />
          <KV label="Pass --model Arg" value={config.codexExecution.passModelArg} />
        </Section>
      ) : null}
      <Section title="治理 & 降级">
        <KV label="降级策略启用" value={config.governance.degradationEnabled} />
        <KV label="Done 超时" value={`${config.governance.doneTimeoutMs / 1000}s`} />
        <KV label="Heartbeat 间隔" value={`${config.governance.heartbeatIntervalMs / 1000}s`} />
      </Section>
    </div>
  );
}
