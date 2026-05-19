import { type DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CatData, saveCatOrder } from '@/hooks/useCatData';
import { sortCatsByOrder } from '@/lib/sort-cats-by-order';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import { DefaultCatSelector } from './DefaultCatSelector';
import { HubCoCreatorOverviewCard, HubMemberOverviewCard, HubOverviewToolbar } from './HubMemberOverviewCard';
import { BubbleToggle } from './settings/BubbleToggle';
import { SettingsField, SettingsSection, SettingsStatusStrip } from './settings/primitives';

/** Move srcId to the position of targetId within ids. Returns a new array. */
function reorderIds(ids: string[], srcId: string, targetId: string): string[] {
  const withoutSrc = ids.filter((id) => id !== srcId);
  const targetIdx = withoutSrc.indexOf(targetId);
  if (targetIdx < 0) return ids;
  return [...withoutSrc.slice(0, targetIdx), srcId, ...withoutSrc.slice(targetIdx)];
}

export type { Capabilities, CatConfig, ConfigData, ContextBudget } from './config-viewer-types';

function KV({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  return (
    <SettingsField label={label} inline compact>
      {display}
    </SettingsField>
  );
}

/** Screen 2 summary overview — co-creator card plus member cards */
export function CatOverviewTab({
  config,
  cats,
  onAddMember,
  onEditCoCreator,
  onEditMember,
  onDeleteMember,
  onToggleAvailability,
  togglingCatId,
}: {
  config: ConfigData;
  cats: CatData[];
  onAddMember?: () => void;
  onEditCoCreator?: () => void;
  onEditMember?: (cat: CatData) => void;
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
    <div className="space-y-4">
      <HubOverviewToolbar onAddMember={onAddMember} />
      {/* F154 Phase B: Global default cat selector (AC-B2: always visible, even on error) */}
      <DefaultCatSelector
        cats={cats.filter((c) => c.roster?.available !== false)}
        currentDefaultCatId={defaultCatId ?? ''}
        onSelect={handleDefaultCatSelect}
        isLoading={defaultCatLoading}
        fetchError={defaultCatFetchError}
        saveError={defaultCatSaveError}
        onRetry={fetchDefaultCat}
      />
      {config.coCreator ? <HubCoCreatorOverviewCard coCreator={config.coCreator} onEdit={onEditCoCreator} /> : null}
      {dragError ? <SettingsStatusStrip tone="error">{dragError}</SettingsStatusStrip> : null}
      <div className="space-y-3">
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
      <SettingsStatusStrip tone="muted">按住 ⠿ 拖动卡片可自由排序；点击卡片进入成员配置 →</SettingsStatusStrip>
      {cats.length === 0 && <SettingsStatusStrip tone="muted">未找到成员配置数据</SettingsStatusStrip>}
      {disabledCats.length > 0 && (
        <div className="space-y-3">
          <SettingsStatusStrip tone="muted">已停用成员</SettingsStatusStrip>
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

export function SystemTab({ config, onConfigChange }: { config: ConfigData; onConfigChange?: () => void }) {
  const handleChanged = useCallback(() => onConfigChange?.(), [onConfigChange]);

  return (
    <>
      <SettingsSection title="气泡显示">
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
      </SettingsSection>
      <SettingsSection title="A2A 猫猫互调">
        <div className="space-y-1.5">
          <KV label="启用" value={config.a2a.enabled} />
          <KV label="最大深度" value={config.a2a.maxDepth} />
        </div>
      </SettingsSection>
      <SettingsSection title="记忆 (F3-lite)">
        <div className="space-y-1.5">
          <KV label="启用" value={config.memory.enabled} />
          <KV label="每线程最大 key 数" value={config.memory.maxKeysPerThread} />
        </div>
      </SettingsSection>
      {config.codexExecution ? (
        <SettingsSection title="Codex 推理执行">
          <div className="space-y-1.5">
            <KV label="Model" value={config.codexExecution.model} />
            <KV label="Auth Mode" value={config.codexExecution.authMode} />
            <KV label="Pass --model Arg" value={config.codexExecution.passModelArg} />
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="治理 & 降级">
        <div className="space-y-1.5">
          <KV label="降级策略启用" value={config.governance.degradationEnabled} />
          <KV label="Done 超时" value={`${config.governance.doneTimeoutMs / 1000}s`} />
          <KV label="Heartbeat 间隔" value={`${config.governance.heartbeatIntervalMs / 1000}s`} />
        </div>
      </SettingsSection>
    </>
  );
}
