import copy from './product-copy.json';

export function AssetDocument() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-8 sm:px-10 sm:py-12">
      <header className="border-b border-cafe-subtle pb-7">
        <div className="flex flex-wrap items-center gap-2 text-micro font-medium text-cafe-muted">
          <span className="rounded-full bg-cafe-surface-sunken px-2.5 py-1">{copy.asset.version}</span>
          <span>更新于 {copy.asset.updatedAt}</span>
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-cafe-black sm:text-3xl">{copy.asset.title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-cafe-secondary">{copy.asset.summary}</p>
      </header>

      <div className="space-y-9 py-8">
        {copy.asset.sections.map((section, index) => (
          <section key={section.title} className="grid gap-3 sm:grid-cols-[32px_1fr]">
            <span className="font-mono text-micro text-cafe-muted">0{index + 1}</span>
            <div>
              <h2 className="text-sm font-semibold text-cafe-black">{section.title}</h2>
              <p className="mt-2 text-sm leading-7 text-cafe-secondary">{section.body}</p>
            </div>
          </section>
        ))}
      </div>

      <footer className="border-t border-cafe-subtle pt-5 text-micro text-cafe-muted">
        本页内容来自双方在 clowder-ai-plugins 第 1 号议题中的真实往来。
      </footer>
    </article>
  );
}
