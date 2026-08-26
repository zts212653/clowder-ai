import copy from './product-copy.json';

export function AssetDiscussion() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-6 sm:px-8" data-testid="asset-discussion" aria-label="批注对话">
      <div className="flex items-start justify-between gap-4 border-b border-cafe-subtle pb-4">
        <div>
          <p className="text-micro font-semibold text-cafe-crosspost">正在围绕原文讨论</p>
          <h1 className="mt-1.5 text-lg font-semibold text-cafe-black">记忆归属 · 第 1 段</h1>
        </div>
        <span className="rounded-full bg-cafe-surface-sunken px-2.5 py-1 text-micro text-cafe-muted">3 条批注</span>
      </div>

      <blockquote className="my-5 border-l-2 border-cafe-crosspost/45 bg-cafe-surface-elevated px-4 py-3 text-xs leading-6 text-cafe-secondary">
        关系记忆、长期偏好和互动历史由 Clowder AI 持有。插件可以在授权范围内读取必要片段。
      </blockquote>

      <div className="space-y-3">
        {copy.discussion.map((message, index) => (
          <article
            key={`${message.author}-${message.time}`}
            className={`flex gap-3 rounded-xl p-3 ${index === 1 ? 'bg-cafe-crosspost/[0.055]' : 'bg-cafe-surface-elevated'}`}
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-micro font-semibold ${
                message.author === 'You'
                  ? 'bg-cafe-accent/10 text-cafe-accent'
                  : 'bg-cafe-crosspost/10 text-cafe-crosspost'
              }`}
              aria-hidden="true"
            >
              {message.author.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="text-xs font-semibold text-cafe-black">{message.author}</h2>
                <span className="text-micro text-cafe-muted">{message.time}</span>
                <span className="ml-auto text-micro text-cafe-muted">{message.anchor}</span>
              </div>
              <p className="mt-1.5 text-xs leading-6 text-cafe-secondary">{message.text}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-cafe bg-cafe-surface p-2.5 shadow-sm">
        <span className="flex-1 px-1 text-xs text-cafe-muted">回应这段原文…</span>
        <button
          type="button"
          className="rounded-lg bg-cafe-crosspost px-3 py-1.5 text-micro font-semibold text-[var(--cafe-accent-foreground)]"
        >
          发送批注
        </button>
      </div>
    </section>
  );
}
