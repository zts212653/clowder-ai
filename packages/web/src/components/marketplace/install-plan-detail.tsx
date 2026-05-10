'use client';

import type { InstallPlan, MarketplaceSearchResult } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import { EcosystemBadge, TrustBadge } from './marketplace-badges';

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-20 shrink-0 text-label text-cafe-muted">{label}</span>
      <span className="text-xs font-mono text-cafe">{value}</span>
    </div>
  );
}

export function InstallPlanDetail({
  result,
  plan,
  projectPath,
  onBack,
  onInstalled,
}: {
  result: MarketplaceSearchResult;
  plan: InstallPlan;
  projectPath?: string;
  onBack: () => void;
  onInstalled?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const canAct = (() => {
    switch (plan.mode) {
      case 'delegated_cli':
        return !!plan.delegatedCommand;
      case 'manual_file':
      case 'direct_mcp':
        return !!plan.mcpEntry;
      case 'manual_ui':
        return false;
      default:
        return false;
    }
  })();

  const handleAction = useCallback(async () => {
    if (plan.mode === 'direct_mcp' && plan.mcpEntry) {
      setInstalling(true);
      setInstallResult(null);
      try {
        const payload = projectPath ? { ...plan.mcpEntry, projectPath } : plan.mcpEntry;
        const res = await apiFetch('/api/capabilities/mcp/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as Record<string, string>;
          setInstallResult({ type: 'error', message: data.error ?? `安装失败 (${res.status})` });
          return;
        }
        setInstallResult({ type: 'success', message: '已安装，MCP 配置已写入' });
        onInstalled?.();
      } catch {
        setInstallResult({ type: 'error', message: '网络错误' });
      } finally {
        setInstalling(false);
      }
      return;
    }

    let text = '';
    if (plan.mode === 'delegated_cli' && plan.delegatedCommand) {
      text = plan.delegatedCommand;
    } else if (plan.mode === 'manual_file' && plan.mcpEntry) {
      text = JSON.stringify(plan.mcpEntry, null, 2);
    }
    if (text) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [plan, projectPath, onInstalled]);

  const trustColor =
    result.trustLevel === 'community'
      ? 'bg-[var(--semantic-warning-bg)] text-[var(--semantic-warning-text)]'
      : 'bg-[var(--semantic-success-bg)] text-[var(--semantic-success-text)]';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-cafe-muted hover:text-cafe-secondary"
        >
          <HubIcon name="arrow-left" className="h-3.5 w-3.5" />
          返回
        </button>
        <span className="text-xs text-cafe-muted">·</span>
        <span className="text-xs font-medium text-cafe">安装详情</span>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-opus-bg">
          <HubIcon name="settings" className="h-8 w-8 text-opus-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-cafe">{result.displayName}</h3>
          {result.publisherIdentity && <p className="text-xs text-cafe-muted">{result.publisherIdentity}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <EcosystemBadge ecosystem={result.ecosystem} />
            <TrustBadge level={result.trustLevel} />
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-cafe-secondary">{result.componentSummary}</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleAction}
          disabled={!canAct || installing}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--semantic-success-bg)] px-3 py-1.5 text-xs font-medium text-[var(--semantic-success-text)] transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          <HubIcon name="download" className="h-3.5 w-3.5" />
          {installing ? '安装中...' : copied ? '已复制!' : '安装'}
        </button>
        {installResult && (
          <span
            className={`text-xs ${installResult.type === 'success' ? 'text-[var(--semantic-success-text)]' : 'text-[var(--semantic-error-text)]'}`}
          >
            {installResult.message}
          </span>
        )}
      </div>

      <div className="console-list-card rounded-xl p-3 shadow-[0_4px_16px_rgba(43,33,26,0.06)]">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-cafe">
          <HubIcon name="settings" className="h-3.5 w-3.5" /> 安装配置
        </p>
        {plan.mcpEntry && (
          <>
            {'transport' in plan.mcpEntry && plan.mcpEntry.transport && (
              <ConfigRow label="传输协议" value={plan.mcpEntry.transport} />
            )}
            {'command' in plan.mcpEntry && plan.mcpEntry.command && (
              <ConfigRow label="启动命令" value={plan.mcpEntry.command} />
            )}
            {'args' in plan.mcpEntry && plan.mcpEntry.args && (
              <ConfigRow label="参数" value={plan.mcpEntry.args.join(' ')} />
            )}
          </>
        )}
        <ConfigRow label="安装方式" value={plan.mode.replace('_', ' ')} />
        {plan.metadata?.versionRef && <ConfigRow label="版本" value={plan.metadata.versionRef} />}
      </div>

      {plan.mcpEntry?.env && Object.keys(plan.mcpEntry.env).length > 0 && (
        <div className="console-list-card rounded-xl p-3 shadow-[0_4px_16px_rgba(43,33,26,0.06)]">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-cafe">
            <HubIcon name="key" className="h-3.5 w-3.5" /> 环境变量 (可选)
          </p>
          {Object.entries(plan.mcpEntry.env).map(([key, val]) => (
            <ConfigRow key={key} label={key} value={val} />
          ))}
        </div>
      )}

      {plan.manualSteps && plan.manualSteps.length > 0 && (
        <div className="console-list-card rounded-xl p-3 shadow-[0_4px_16px_rgba(43,33,26,0.06)]">
          <p className="mb-2 text-xs font-medium text-cafe">手动步骤</p>
          <ol className="list-inside list-decimal space-y-1 text-xs text-cafe-secondary">
            {plan.manualSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <div className={`flex items-center gap-1.5 rounded-lg p-2.5 text-xs ${trustColor}`}>
        <HubIcon
          name={result.trustLevel === 'official' ? 'shield' : result.trustLevel === 'verified' ? 'check' : 'users'}
          className="h-3.5 w-3.5 shrink-0"
        />
        {result.trustLevel === 'official'
          ? '官方认证服务，由平台维护'
          : result.trustLevel === 'verified'
            ? '社区验证服务，经审核'
            : '社区贡献服务，使用前请审查'}
      </div>
    </div>
  );
}
