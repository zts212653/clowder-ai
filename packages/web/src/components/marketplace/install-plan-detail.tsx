'use client';

import type { InstallPlan, MarketplaceSearchResult } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { HubIcon } from '../hub-icons';
import { EcosystemBadge, InstallModeBadge, TrustBadge } from './marketplace-badges';

const MODE_ACTION: Record<string, { label: string; icon: string; hint: string }> = {
  direct_mcp: { label: '安装到当前猫猫', icon: 'download', hint: '将自动写入 MCP 配置并重启' },
  delegated_cli: { label: '复制 CLI 命令', icon: 'copy', hint: '粘贴到终端执行安装' },
  manual_file: { label: '复制配置文件', icon: 'copy', hint: '粘贴到对应的配置文件中' },
  manual_ui: { label: '打开设置', icon: 'external-link', hint: '在对应平台设置界面中配置' },
};

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-cafe-border/50 py-1.5 last:border-0">
      <span className="w-20 shrink-0 text-[11px] text-cafe-muted">{label}</span>
      <span className="text-xs font-mono text-cafe">{value}</span>
    </div>
  );
}

export function InstallPlanDetail({
  result,
  plan,
  onBack,
}: {
  result: MarketplaceSearchResult;
  plan: InstallPlan;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const action = MODE_ACTION[plan.mode] ?? MODE_ACTION.manual_file;

  const handleAction = useCallback(() => {
    let text = '';
    if (plan.mode === 'delegated_cli' && plan.delegatedCommand) {
      text = plan.delegatedCommand;
    } else if (plan.mode === 'manual_file' && plan.mcpEntry) {
      text = JSON.stringify(plan.mcpEntry, null, 2);
    } else if (plan.mode === 'direct_mcp') {
      return;
    }
    if (text) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [plan]);

  const canAct = (() => {
    switch (plan.mode) {
      case 'delegated_cli':
        return !!plan.delegatedCommand;
      case 'manual_file':
        return !!plan.mcpEntry;
      case 'direct_mcp':
      case 'manual_ui':
        return false;
      default:
        return false;
    }
  })();

  const trustColor = result.trustLevel === 'community' ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-cafe-muted hover:text-cafe-secondary">
          <HubIcon name="arrow-left" className="h-3.5 w-3.5" />
          返回
        </button>
        <span className="text-xs text-cafe-muted">·</span>
        <span className="text-xs font-medium text-cafe">安装详情</span>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50">
          <HubIcon name="settings" className="h-5 w-5 text-purple-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-cafe">{result.displayName}</h3>
          {result.publisherIdentity && <p className="text-xs text-cafe-muted">{result.publisherIdentity}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <EcosystemBadge ecosystem={result.ecosystem} />
            <TrustBadge level={result.trustLevel} />
            <InstallModeBadge mode={plan.mode} />
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-cafe-secondary">{result.componentSummary}</p>

      <div className="rounded-lg border border-cafe-border bg-white p-3">
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
        <div className="rounded-lg border border-cafe-border bg-white p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-cafe">
            <HubIcon name="key" className="h-3.5 w-3.5" /> 环境变量 (可选)
          </p>
          {Object.entries(plan.mcpEntry.env).map(([key, val]) => (
            <ConfigRow key={key} label={key} value={val} />
          ))}
        </div>
      )}

      {plan.manualSteps && plan.manualSteps.length > 0 && (
        <div className="rounded-lg border border-cafe-border bg-white p-3">
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

      <div>
        <button
          onClick={handleAction}
          disabled={!canAct}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          <HubIcon name={action.icon} className="h-4 w-4" />
          {copied ? '已复制!' : action.label}
        </button>
        <p className="mt-1.5 text-center text-[10px] text-cafe-muted">{action.hint}</p>
      </div>
    </div>
  );
}
