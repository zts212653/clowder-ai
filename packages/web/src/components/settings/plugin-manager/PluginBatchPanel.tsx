'use client';

import { useState } from 'react';
import { HubIcon } from '../../hub-icons';
import { PluginVisual } from './PluginVisual';
import type { PluginBatchEntry } from './plugin-batch-model';
import { batchResultPending, batchResultProblem, batchResultText, batchResultTitle } from './plugin-batch-model';
import { pluginStatusLabel } from './plugin-manager-attention';
import type { PluginBatchController } from './usePluginBatch';

const blockLabels = {
  configuration: '去填写 ›',
  authorization: '去授权 ›',
  transition: '等一会儿',
  incompatible: '等兼容版本',
  catalog: '再试一次',
  unavailable: '查看详情 ›',
};
export function PluginBatchPanel({
  entries,
  controller,
  onDetail,
  onRetry,
  onRepair,
}: {
  entries: readonly PluginBatchEntry[];
  controller: PluginBatchController;
  onDetail: (id: string) => void;
  onRetry?: () => void;
  onRepair?: (id: string) => void;
}) {
  const { phase, results } = controller;
  const candidates = entries.filter((e) => e.action);
  const [excluded, setExcluded] = useState(new Set<string>());
  const selected = candidates.filter((e) => !excluded.has(e.plugin.id));
  const needsOwner = entries.filter((e) => e.blocked === 'configuration' || e.blocked === 'authorization');
  const waiting = entries.filter((e) => e.blocked && e.blocked !== 'configuration' && e.blocked !== 'authorization');
  const lookup = new Map(entries.map((e) => [e.plugin.id, e]));
  const blockedRows = (rows: readonly PluginBatchEntry[]) =>
    rows.map((e) => (
      <div key={e.plugin.id} className="flex items-center gap-3 py-3">
        <PluginVisual icon={e.plugin.icon} name={e.plugin.displayName} className="!h-7 !w-7" />
        <div className="min-w-0 flex-1 text-sm text-cafe">
          <p>{e.plugin.displayName}</p>
          <p className="text-xs text-cafe-muted">{pluginStatusLabel(e.plugin, 'zh-CN')}</p>
        </div>
        <button
          type="button"
          className="shrink-0 text-xs text-cafe-accent"
          onClick={() => (e.blocked === 'catalog' ? onRetry?.() : onDetail(e.plugin.id))}
        >
          {e.blocked && blockLabels[e.blocked]}
        </button>
      </div>
    ));
  const blockedSections = () => (
    <>
      {needsOwner.length > 0 && (
        <div className="mt-4 border-t border-cafe-border pt-4">
          <h3 className="text-xs font-semibold text-cafe-muted">要你补一下 · {needsOwner.length}</h3>
          {blockedRows(needsOwner)}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="mt-3 border-t border-cafe-border pt-4">
          <h3 className="text-xs font-semibold text-cafe-muted">暂时不能一起处理 · {waiting.length}</h3>
          {blockedRows(waiting)}
        </div>
      )}
    </>
  );
  return (
    <section
      data-plugin-batch
      data-batch-phase={phase}
      className="rounded-xl border border-cafe-border bg-[var(--console-card-bg)] px-[22px] py-5 text-cafe"
    >
      <h2 className="text-base font-semibold">
        {phase === 'confirm'
          ? '一起处理'
          : phase === 'running'
            ? `正在处理 · 第 ${Math.min(results.filter((r) => r.state !== 'queued').length || 1, results.length)} 个，共 ${results.length} 个`
            : batchResultTitle(results)}
      </h2>
      {phase === 'confirm' ? (
        <>
          <p className="mt-1 text-sm text-cafe-secondary">先看清每一项将要做什么，可以取消不想处理的。</p>
          <div className="mt-4 divide-y divide-cafe-border">
            {candidates.map((e) => (
              <label key={e.plugin.id} className="flex cursor-pointer items-start gap-3 py-4">
                <input
                  type="checkbox"
                  aria-label={`处理 ${e.plugin.displayName}`}
                  className="mt-1 h-4 w-4 accent-[var(--cafe-text)]"
                  checked={!excluded.has(e.plugin.id)}
                  onChange={(event) =>
                    setExcluded((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(e.plugin.id);
                      else next.add(e.plugin.id);
                      return next;
                    })
                  }
                />
                <PluginVisual icon={e.plugin.icon} name={e.plugin.displayName} className="!h-7 !w-7" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{e.plugin.displayName}</span>
                  <span className="block text-xs text-cafe-muted">
                    {pluginStatusLabel(e.plugin, 'zh-CN')} · {e.plugin.installedVersion}
                  </span>
                  <span className="mt-1.5 block text-sm">
                    → {e.action?.kind === 'update' ? `更新到 ${e.action.version}` : '修复当前版本'}
                  </span>
                  {e.action?.kind === 'update' && (
                    <span className="mt-1 block text-xs text-cafe-muted">
                      {e.plugin.intent === 'enabled' ? '更新后会试着重新启动' : '更新后不会自动打开'}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {blockedSections()}
          <p className="mt-5 text-xs leading-relaxed text-cafe-muted">
            开着的插件更新时会重新启动，正在用它的猫会断开一小会儿。
          </p>
          <div className="mt-4 flex gap-2 border-t border-cafe-border pt-4">
            <button
              type="button"
              className="console-button-primary"
              disabled={!selected.length}
              onClick={() => void controller.start(selected)}
            >
              开始处理 {selected.length} 个
            </button>
            <button type="button" className="console-button-secondary" onClick={controller.close}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-xs leading-relaxed text-cafe-muted">
            离开这一页，后面的就不再开始；已经开始的那一个服务器会继续做，结果以你回来后插件的实际状态为准。
          </p>
          <div aria-live="polite" className="mt-4 divide-y divide-cafe-border">
            {results.map((r) => {
              const e = lookup.get(r.id);
              const pending = batchResultPending(r);
              const warning = r.state === 'unknown' || batchResultProblem(r);
              return (
                <div key={r.id} className="flex items-start gap-3 py-4">
                  <span
                    aria-hidden="true"
                    className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center ${warning || pending ? 'text-conn-amber-text' : 'text-conn-emerald-text'}`}
                  >
                    {r.state === 'working' ? (
                      <span className="h-3 w-3 animate-spin rounded-full border border-cafe-border border-t-current" />
                    ) : warning ? (
                      <span className="h-2 w-2 rounded-full bg-current" />
                    ) : !pending && (r.state === 'updated' || r.state === 'repaired') ? (
                      <HubIcon name="check" className="h-4 w-4" />
                    ) : (
                      <span className="h-2 w-2 rounded-full border border-cafe-border" />
                    )}
                  </span>
                  <PluginVisual
                    icon={e?.plugin.icon ?? 'blocks'}
                    name={e?.plugin.displayName ?? r.id}
                    className="!h-7 !w-7"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{e?.plugin.displayName ?? r.id}</p>
                    <p
                      data-batch-result={r.state}
                      className={`mt-1 text-sm ${warning ? 'text-conn-amber-text' : pending ? 'text-cafe-secondary' : r.state === 'updated' || r.state === 'repaired' ? 'text-conn-emerald-text' : 'text-cafe-secondary'}`}
                    >
                      {batchResultText(r)}
                    </p>
                    {r.state === 'updated' && r.disabled && (
                      <p className="mt-1 text-xs text-cafe-muted">仍是停用的，要用时打开开关</p>
                    )}
                    {warning && (
                      <div className="mt-2 flex gap-3 text-xs">
                        {r.state === 'updated' && !r.disabled && r.repairAllowed && onRepair && (
                          <button
                            type="button"
                            className="console-button-secondary"
                            onClick={() => {
                              controller.close();
                              onRepair(r.id);
                            }}
                          >
                            修复
                          </button>
                        )}
                        <button type="button" onClick={() => onDetail(r.id)}>
                          技术详情 ›
                        </button>
                      </div>
                    )}
                    {r.message && r.state === 'unknown' && <p className="text-xs text-cafe-muted">{r.message}</p>}
                  </div>
                </div>
              );
            })}
          </div>
          {blockedSections()}
          <div className="mt-4 flex border-t border-cafe-border pt-4">
            <button
              type="button"
              className="console-button-secondary"
              onClick={phase === 'running' ? controller.stop : controller.close}
            >
              {phase === 'running' ? '后面的先不做了' : '好了'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
