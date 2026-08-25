import { ApprovalDecisionCard } from '@/components/ApprovalDecisionCard';
import { outputs, SOURCE_HANDLE } from './preview-data';

// Frozen design-evidence fixture: these no-op slots must not import the live
// F292 action adapters. The shared card shell is the only production pattern.

export function CandidateMeetingCard({
  repair,
  editOpen,
  onEditToggle,
}: {
  repair: boolean;
  editOpen: boolean;
  onEditToggle: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <ApprovalDecisionCard
        testId="f305-candidate-card"
        header={
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-[var(--semantic-info-subtle)] px-2 py-1 text-micro font-semibold text-[var(--semantic-info)]">
              会议
            </span>
            <span className="text-micro font-semibold text-cafe-secondary">等你确认</span>
            <span className="ml-auto text-micro text-cafe-muted">刚刚</span>
          </div>
        }
        title="整理会议：模型质量周会"
        actionReason={
          <div className="flex items-start gap-2">
            <p>
              <span className="font-semibold text-cafe">为什么需要我：</span>
              会议记录已经整理好了。请确认要生成的资料和保存位置。
            </p>
          </div>
        }
        recommendation={repair ? undefined : <Recommendation />}
        currentDecision={
          <div className="space-y-3">
            {repair ? (
              <RepairPanel />
            ) : (
              <>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium hover:bg-cafe-muted sm:mr-auto"
                    onClick={onEditToggle}
                    data-testid="f305-edit-toggle"
                    aria-expanded={editOpen}
                  >
                    {editOpen ? '收起修改' : '有内容要改'}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-cafe-interactive px-4 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] shadow-sm hover:opacity-90"
                    data-testid="f305-primary-action"
                  >
                    确认并开始整理
                  </button>
                </div>
                {editOpen && <MeetingEditPanel />}
              </>
            )}
            <footer className="flex items-center justify-between gap-3 border-t border-cafe-subtle pt-3">
              <span className="text-micro text-cafe-muted">确认后猫猫才会开始整理。</span>
              <button type="button" className="shrink-0 text-micro font-medium text-cafe-secondary hover:text-cafe">
                这次不用整理
              </button>
            </footer>
          </div>
        }
        details={{
          label: '查看原会议和记录',
          testId: 'f305-source-details',
          content: <SourceDetails />,
        }}
      />
    </div>
  );
}

function Recommendation() {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-3.5" aria-label="猫猫建议">
      <div className="mb-3 flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-cafe-interactive" fill="none" stroke="currentColor">
          <title>建议</title>
          <path
            d="M9 18h6m-5 3h4m3-11a5 5 0 1 0-10 0c0 2 1 3 2 4 .7.7 1 1.4 1 2h4c0-.6.3-1.3 1-2 1-1 2-2 2-4Z"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <h3 className="text-xs font-semibold">猫猫建议</h3>
        <span className="rounded-md border border-cafe px-1.5 py-0.5 text-micro text-cafe-muted">可调整</span>
      </div>
      <dl className="grid gap-2.5 text-xs sm:grid-cols-[88px_1fr]">
        <dt className="text-cafe-muted">将生成</dt>
        <dd className="font-medium">会议摘要 · 已确认决定 · 待办清单</dd>
        <dt className="text-cafe-muted">保存到</dt>
        <dd className="font-medium">模型质量专项</dd>
        <dt className="text-cafe-muted">参会人</dt>
        <dd className="font-medium">You、砚砚、宪宪</dd>
      </dl>
    </section>
  );
}

function MeetingEditPanel() {
  return (
    <section className="space-y-3 rounded-xl border border-cafe bg-cafe-surface p-3.5" aria-label="调整建议">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">修改整理内容</h3>
        <span className="text-micro text-cafe-muted">只改不准确的地方</span>
      </div>
      <label className="block text-micro font-medium">
        发言人称呼
        <textarea
          defaultValue={'1=You\n2=砚砚\n3=宪宪'}
          rows={3}
          className="mt-1 w-full rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-xs"
          data-testid="meeting-speakers"
        />
      </label>
      <label className="block text-micro font-medium">
        这次会议主要讨论什么
        <textarea
          defaultValue="复盘本周模型质量变化，确认需要继续观察的问题和负责人。"
          rows={2}
          className="mt-1 w-full rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-xs"
          data-testid="meeting-context"
        />
      </label>
      <label className="block text-micro font-medium">
        保存位置
        <input
          defaultValue="模型质量专项"
          className="mt-1 w-full rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-xs"
          data-testid="meeting-destination"
        />
      </label>
      <fieldset>
        <legend className="mb-2 text-micro font-medium">要生成的内容</legend>
        <div className="flex flex-wrap gap-2">
          {outputs.map((output, index) => (
            <label
              key={output}
              className="flex items-center gap-1.5 rounded-lg border border-cafe px-2.5 py-1.5 text-micro"
            >
              <input
                type="checkbox"
                defaultChecked={index !== 2}
                data-testid={`meeting-output-${index === 0 ? 'minutes' : index}`}
              />
              {output}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

export function RepairPanel() {
  return (
    <section
      className="rounded-xl border border-[var(--semantic-warning)] bg-[var(--semantic-warning-subtle)] p-3.5"
      data-testid="f305-repair"
    >
      <div className="flex items-start gap-3">
        <svg
          viewBox="0 0 24 24"
          className="mt-0.5 h-5 w-5 shrink-0 text-[var(--semantic-warning)]"
          fill="none"
          stroke="currentColor"
        >
          <title>需要连接飞书</title>
          <path
            d="M12 9v4m0 4h.01M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold">飞书连接已失效</h3>
          <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">
            会议记录和当前建议都还在。重新连接后可在这里原地继续，不需要重新导入。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg bg-[var(--semantic-warning)] px-3.5 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)]"
              data-testid="f305-repair-action"
            >
              重新连接飞书
            </button>
            <button type="button" className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium">
              我已连接，再试一次
            </button>
            <button type="button" className="rounded-lg px-2 py-2 text-xs font-medium text-cafe-secondary">
              改为粘贴会议记录
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SourceDetails() {
  return (
    <dl className="mt-2 grid gap-1.5 break-all rounded-lg bg-cafe-surface-sunken p-3 text-micro text-cafe-secondary sm:grid-cols-[74px_1fr]">
      <dt className="text-cafe-muted">原会议</dt>
      <dd>{SOURCE_HANDLE}</dd>
      <dt className="text-cafe-muted">版本</dt>
      <dd>rev 1</dd>
      <dt className="text-cafe-muted">记录编号</dt>
      <dd>obcnj98z126oab1n999i9xg2</dd>
    </dl>
  );
}
