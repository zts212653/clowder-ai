import { type NativePartner, SMALL_GOALS } from './native-onboarding';
import { goalRole, orderGoalPartners } from './native-team-goal';

export function NativeGoalStep({
  selected,
  lead,
  goal,
  busy,
  patch,
}: {
  selected: NativePartner[];
  lead: string;
  goal: string;
  busy: boolean;
  patch: (change: { goal?: string; lead?: string }) => void;
}) {
  const ordered = orderGoalPartners(selected, lead);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {SMALL_GOALS.map((item) => (
          <button
            key={item.title}
            type="button"
            disabled={busy}
            onClick={() => patch({ goal: item.content })}
            className={`min-h-10 rounded-full border px-4 text-sm ${goal === item.content ? 'border-cafe-accent text-cafe-accent' : 'border-[var(--console-border-soft)] text-cafe-secondary'}`}
          >
            {item.title}
          </button>
        ))}
      </div>
      <label className="block text-sm font-medium">
        你想完成什么？
        <textarea
          disabled={busy}
          value={goal}
          onChange={(e) => patch({ goal: e.target.value })}
          placeholder="例如：把我的想法整理为今天可以完成的三步计划"
          rows={3}
          maxLength={4000}
          className="mt-3 w-full resize-y rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-4 font-normal leading-relaxed focus:border-cafe-accent"
        />
      </label>
      {ordered.length > 1 ? (
        <>
          <label className="block text-sm font-medium">
            谁先提出方案？
            <select
              disabled={busy}
              value={ordered[0]?.id ?? ''}
              onChange={(e) => patch({ lead: e.target.value })}
              className="mt-2 block min-h-11 w-full rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface-canvas px-3 font-normal"
            >
              {selected.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.form.displayName} · {p.runtime.label}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-xl bg-cafe-surface-canvas p-4">
            <p className="mb-3 text-sm font-medium">这次如何协作</p>
            <ol className="grid gap-3 sm:grid-cols-3">
              {ordered.map((partner, index) => (
                <li key={partner.id} className="flex items-start gap-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--console-border-soft)] text-cafe-accent">
                    {index + 1}
                  </span>
                  <div>
                    <span className="font-medium">{partner.form.displayName}</span>
                    <span className="ml-2 text-cafe-muted">{partner.runtime.label}</span>
                    <p className="mt-1 text-cafe-secondary">{goalRole(index, ordered.length).title}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs leading-relaxed text-cafe-muted">
              依次接力，后面的伙伴会看到前面的结果，最后一位检查并汇总。每位伙伴都会参与。
            </p>
          </div>
        </>
      ) : (
        <p className="rounded-xl bg-cafe-surface-canvas p-4 text-sm">
          由 {ordered[0]?.form.displayName} 完成。以后添加更多伙伴，就能一起协作。
        </p>
      )}
      <p className="text-xs leading-relaxed text-cafe-muted">
        目标{ordered.length > 1 ? '和协作分工' : ''}
        会放进对话输入框，你确认发送后开始真实调用，使用各工具现有的登录配置。
      </p>
    </div>
  );
}
