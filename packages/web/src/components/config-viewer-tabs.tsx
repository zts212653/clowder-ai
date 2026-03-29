import { type ReactNode, useCallback, useRef, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import { HubCoCreatorOverviewCard, HubMemberOverviewCard, HubOverviewToolbar } from './HubMemberOverviewCard';

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
  return (
    <div className="space-y-4">
      <HubOverviewToolbar onAddMember={onAddMember} />
      {config.coCreator ? <HubCoCreatorOverviewCard coCreator={config.coCreator} onEdit={onEditCoCreator} /> : null}
      <div className="space-y-3">
        {cats.map((catData) => (
          <HubMemberOverviewCard
            key={catData.id}
            cat={catData}
            configCat={config.cats[catData.id]}
            onEdit={onEditMember}
            onToggleAvailability={onToggleAvailability}
            togglingAvailability={togglingCatId === catData.id}
          />
        ))}
      </div>
      <p className="text-[13px] text-[#B59A88]">点击任意卡片进入成员配置 →</p>
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
