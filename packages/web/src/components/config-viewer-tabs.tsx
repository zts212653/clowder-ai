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
  onEditMember,
}: {
  config: ConfigData;
  cats: CatData[];
  onAddMember?: () => void;
  onEditMember?: (cat: CatData) => void;
}) {
  return (
    <div className="space-y-3">
      <HubOverviewToolbar onAddMember={onAddMember} />
      {config.owner ? <HubOwnerOverviewCard owner={config.owner} /> : null}
      <div className="space-y-3">
        {cats.map((catData) => (
          <HubMemberOverviewCard
            key={catData.id}
            cat={catData}
            configCat={config.cats[catData.id]}
            onEdit={onEditMember}
          />
        ))}
      </div>
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
      <Section title="Hindsight 长期记忆">
        <div className="space-y-1.5">
          <KV label="启用" value={config.hindsight.enabled} />
          <KV label="Base URL" value={config.hindsight.baseUrl} />
          <KV label="共享 Bank" value={config.hindsight.sharedBank} />
          {config.hindsight.recallDefaults ? (
            <>
              <KV label="Recall Budget" value={config.hindsight.recallDefaults.budget} />
              <KV label="Recall TagsMatch" value={config.hindsight.recallDefaults.tagsMatch} />
              <KV label="Recall Limit" value={config.hindsight.recallDefaults.limit} />
            </>
          ) : null}
          {config.hindsight.retainPolicy ? (
            <>
              <KV label="Narrative Fact Required" value={config.hindsight.retainPolicy.narrativeFactRequired} />
              <KV label="Min Useful Horizon Days" value={config.hindsight.retainPolicy.minUsefulHorizonDays} />
              {typeof config.hindsight.retainPolicy.anchorRequired === 'boolean' ? (
                <KV label="Anchor Required" value={config.hindsight.retainPolicy.anchorRequired} />
              ) : null}
            </>
          ) : null}
          {config.hindsight.reflect ? (
            <KV label="Reflect Disposition" value={config.hindsight.reflect.dispositionMode} />
          ) : null}
        </div>
      </Section>
      {config.hindsight.engine ? (
        <Section title="引擎路由">
          <div className="space-y-1.5">
            <KV label="Reflect Engine" value={config.hindsight.engine.reflect} />
            <KV label="Retain Extraction Engine" value={config.hindsight.engine.retainExtraction} />
            <KV label="allowNativeFallback" value={config.hindsight.engine.allowNativeFallback} />
          </div>
        </Section>
      ) : null}
      {config.hindsight.service ? (
        <Section title="Hindsight 独立服务">
          <div className="space-y-1.5">
            <KV label="服务模式" value={config.hindsight.service.mode} />
            <KV label="requireHealthcheck" value={config.hindsight.service.requireHealthcheck} />
            <KV label="写入超时(ms)" value={config.hindsight.service.writeTimeoutMs} />
            <KV label="检索超时(ms)" value={config.hindsight.service.recallTimeoutMs} />
          </div>
        </Section>
      ) : null}
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
