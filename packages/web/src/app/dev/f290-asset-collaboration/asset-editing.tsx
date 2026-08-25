import { ApprovalDecisionCard } from '@/components/ApprovalDecisionCard';
import copy from './product-copy.json';

export function AssetEditing() {
  return (
    <section className="mx-auto max-w-3xl space-y-5 px-6 py-7 sm:px-10 sm:py-9" aria-label="修改建议">
      <div>
        <p className="text-micro font-semibold text-cafe-interactive">正在审阅修改建议</p>
        <h1 className="mt-2 text-xl font-semibold text-cafe-black">{copy.asset.title}</h1>
        <p className="mt-1 text-xs text-cafe-muted">这处修改来自吴浪的新版本，等待确认。</p>
      </div>

      <ApprovalDecisionCard
        testId="asset-change-decision"
        title={copy.change.title}
        actionReason={copy.change.reason}
        recommendation={
          <div>
            <p className="text-micro font-semibold text-cafe-secondary">建议</p>
            <p className="mt-1 text-xs leading-5 text-cafe">{copy.change.recommendation}</p>
          </div>
        }
        currentDecision={
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-cafe-surface-sunken p-3">
              <p className="text-micro font-medium text-cafe-muted">修改前</p>
              <p className="mt-1.5 text-xs leading-5 text-cafe-secondary line-through decoration-cafe-muted/60">
                {copy.change.before}
              </p>
            </div>
            <div className="rounded-lg border border-cafe-interactive/25 bg-cafe-surface-elevated p-3">
              <p className="text-micro font-medium text-cafe-interactive">修改后</p>
              <p className="mt-1.5 text-xs leading-5 text-cafe">{copy.change.after}</p>
            </div>
          </div>
        }
        details={{
          label: '查看对应批注',
          content: 'You：关系记忆不能跟着插件停用一起消失，这条边界需要保留。',
        }}
      />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
        >
          保留分歧
        </button>
        <button
          type="button"
          className="rounded-lg bg-cafe-interactive px-3.5 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] shadow-sm hover:opacity-90"
        >
          接受并更新
        </button>
      </div>
    </section>
  );
}
