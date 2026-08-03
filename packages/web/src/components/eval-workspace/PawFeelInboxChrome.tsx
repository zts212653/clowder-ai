'use client';

import type { PawFeelInboxPage } from '@cat-cafe/shared';
import { PawFeelInboxBundle } from './PawFeelInboxBundle';
import type { DutyReadState } from './usePawFeelDuty';

export function PawFeelInboxHeader({ title, page }: { title: string; page: PawFeelInboxPage | null }) {
  const healthy = page?.coverage?.status === 'healthy';
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-cafe">{title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-cafe-secondary">
          按消息与调用上下文组成确定性审阅包；展开后仍可逐条查看原始报告。问题族暂无权威语义分组。
        </p>
      </div>
      {page?.coverage ? (
        <span
          className={`inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap text-micro font-semibold ${healthy ? 'text-conn-green-text' : 'text-conn-amber-text'}`}
          title={`coverage · ${page.coverage.status}`}
        >
          <span className={`h-2 w-2 rounded-full ${healthy ? 'bg-conn-green-text' : 'bg-conn-amber-text'}`} />
          {healthy ? '覆盖正常' : '覆盖降级'}
        </span>
      ) : null}
    </div>
  );
}

export function PawFeelDutyBanner({
  variant,
  duty,
  page,
}: {
  variant: 'workspace' | 'history';
  duty: DutyReadState;
  page: PawFeelInboxPage | null;
}) {
  if (variant !== 'workspace' || duty.status === 'loading') return null;
  if (duty.status === 'unassigned') {
    return (
      <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
        <div className="font-semibold">当前无人值班，尚未开始责任审阅</div>
        <div className="mt-1 font-medium">
          0 / 2 位值班猫 · {page?.denominator.reportOccurrences ?? 0} 条报告 · {page?.denominator.reviewBundles ?? 0}{' '}
          个审阅包 · {page?.counts.overdue ?? 0} 条 72h+
        </div>
        <div className="mt-1">
          未看信号仍会完整入箱，但不会自动猜责任猫。请到{' '}
          <a className="underline" href="/settings?ops=observability&obs=eval">
            设置 → 可观测性 → 评估
          </a>{' '}
          指定 primary / backup。
        </div>
      </div>
    );
  }
  if (duty.status === 'incomplete') {
    return (
      <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
        <div className="font-semibold">值班配置不完整，尚未开始责任审阅</div>
        <div className="mt-1 font-medium">
          0 / 2 位可运营值班猫 · {page?.denominator.reportOccurrences ?? 0} 条报告 ·{' '}
          {page?.denominator.reviewBundles ?? 0} 个审阅包 · {page?.counts.overdue ?? 0} 条 72h+
        </div>
        <div className="mt-1">
          当前只记录了
          {duty.config.primaryCatId ? ` primary @${duty.config.primaryCatId}` : ' primary 未指定'}
          {duty.config.backupCatId ? ` / backup @${duty.config.backupCatId}` : ' / backup 未指定'}； 必须同时配置不同的
          primary / backup，系统不会把一只猫冒充另一班。
        </div>
      </div>
    );
  }
  if (duty.status === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
        值班状态暂不可读；系统不会据此猜测责任猫。
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-conn-green-ring pl-2.5 text-xs text-cafe-secondary">
      <span className="font-semibold text-conn-green-text">值班已就绪</span>
      <span className="whitespace-nowrap">Primary @{duty.config.primaryCatId}</span>
      <span className="whitespace-nowrap">Backup @{duty.config.backupCatId}</span>
      <span className="whitespace-nowrap text-cafe-muted">24h 接管 · 72h operator 红灯</span>
    </div>
  );
}

export function PawFeelInboxNotices({ page, error }: { page: PawFeelInboxPage | null; error: string | null }) {
  return (
    <>
      {page?.degraded ? (
        <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          embedding 健康暂不可用；此页面当前不提供 live 语义分组。确定性上下文审阅包与全部原始报告继续可见。
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="alert">
          {error}
        </div>
      ) : null}
      {page?.projectionStatus === 'unavailable' ? (
        <div className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="alert">
          处置台账暂不可用：{page.unavailableReason ?? 'unknown'}
        </div>
      ) : null}
    </>
  );
}

export function PawFeelInboxBody({
  page,
  loading,
  loadingMore,
  onLoadMore,
}: {
  page: PawFeelInboxPage | null;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (loading && !page) return <p className="mt-3 text-xs text-cafe-muted">正在读取责任收件箱…</p>;
  if (page?.projectionStatus === 'available' && page.bundles.length === 0) {
    return (
      <p className="mt-3 rounded-md bg-cafe-surface px-3 py-3 text-xs text-cafe-secondary">
        当前筛选下没有报告；完整历史仍保留在同一台账中。
      </p>
    );
  }
  return (
    <>
      {page?.bundles.length ? (
        <div
          className="mt-3 divide-y divide-[var(--console-border-soft)] overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)]"
          data-testid="paw-feel-bundle-list"
        >
          {page.bundles.map((bundle) => (
            <PawFeelInboxBundle key={bundle.bundleKey} bundle={bundle} />
          ))}
        </div>
      ) : null}
      {page ? (
        <p className="mt-2 text-micro text-cafe-muted">问题族数不可可靠计算；semantic grouping 本阶段冻结。</p>
      ) : null}
      {page?.nextCursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={onLoadMore}
          className="mt-3 w-full rounded-md border border-cafe px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-50"
        >
          {loadingMore ? '加载中…' : '再看 50 条'}
        </button>
      ) : null}
    </>
  );
}
