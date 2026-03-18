import { type ReactNode } from 'react';
import type { CatData } from '@/hooks/useCatData';
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

/** Unified cat overview — all cats' model & budget in one tab */
export function CatOverviewTab({ config, cats }: { config: ConfigData; cats: CatData[] }) {
  // One card per breed (default variant only)
  const breeds = cats.filter((c) => c.isDefaultVariant !== false).slice(0, 3);

  return (
    <div className="space-y-3">
      {breeds.map((catData) => {
        const cat = config.cats[catData.id];
        const budget = config.perCatBudgets[catData.id];
        if (!cat || !budget) return null;
        const name = catData.breedDisplayName ?? catData.displayName;
        return (
          <Section key={catData.id} title={name}>
            <div className="space-y-1.5">
              <KV label="Provider" value={cat.provider} />
              <KV label="Model" value={cat.model} />
              <KV label="MCP 交付" value={cat.mcpSupport ? '原生 (--mcp-config)' : 'HTTP 回调注入'} />
              <KV label="Prompt 上限" value={`${(budget.maxPromptTokens / 1000).toFixed(0)}k tokens`} />
              <KV label="上下文上限" value={`${(budget.maxContextTokens / 1000).toFixed(0)}k tokens`} />
              <KV label="消息数上限" value={budget.maxMessages} />
              <KV label="单消息上限" value={`${(budget.maxContentLengthPerMsg / 1000).toFixed(0)}k chars`} />
            </div>
          </Section>
        );
      })}
      {breeds.length === 0 && <p className="text-sm text-gray-400">未找到猫猫配置数据</p>}
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
