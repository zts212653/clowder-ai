import { type ReactNode } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { HubMemberOverviewCard, HubOverviewToolbar, HubOwnerOverviewCard } from './HubMemberOverviewCard';
import type { ConfigData } from './config-viewer-types';

export type { Capabilities, CatConfig, ConfigData, ContextBudget } from './config-viewer-types';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h3 className="text-xs font-semibold text-gray-700 mb-2">{title}</h3>
      {children}
    </section>
  );
}

function KV({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  return (
    <div className="flex justify-between text-xs text-gray-700">
      <span>{label}</span>
      <span className="font-medium text-right">{display}</span>
    </div>
  );
}

/** Screen 2 summary overview — owner card plus member cards */
export function CatOverviewTab({
  config,
  cats,
  onAddMember,
  onEditOwner,
  onEditMember,
  onToggleAvailability,
  togglingCatId,
}: {
  config: ConfigData;
  cats: CatData[];
  onAddMember?: () => void;
  onEditOwner?: () => void;
  onEditMember?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  togglingCatId?: string | null;
}) {
  return (
    <div className="space-y-4">
      <HubOverviewToolbar onAddMember={onAddMember} />
      {config.owner ? <HubOwnerOverviewCard owner={config.owner} onEdit={onEditOwner} /> : null}
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
      {cats.length === 0 && <p className="text-sm text-gray-400">未找到成员配置数据</p>}
    </div>
  );
}

export function SystemTab({ config }: { config: ConfigData }) {
  return (
    <>
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
