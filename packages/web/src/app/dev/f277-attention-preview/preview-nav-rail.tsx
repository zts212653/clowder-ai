export function PreviewSearchIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <circle cx="7" cy="7" r="4.5" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function NavGlyph({ kind }: { kind: 'chat' | 'grid' | 'home' }) {
  const path =
    kind === 'chat'
      ? 'M3 3h10v7H7l-3 3v-3H3V3Z'
      : kind === 'grid'
        ? 'M3 3h4v4H3V3Zm6 0h4v4H9V3ZM3 9h4v4H3V9Zm6 0h4v4H9V9Z'
        : 'm2.5 7 5.5-4.5L13.5 7v6h-4V9h-3v4h-4V7Z';
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path d={path} strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

export function PreviewNavRail() {
  return (
    <nav
      aria-label="主导航"
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-cafe bg-[var(--console-panel-bg)] py-3"
    >
      <div className="mb-2 grid h-8 w-8 place-items-center rounded-xl bg-cafe-accent text-[var(--cafe-accent-foreground)] text-xs font-bold">
        CC
      </div>
      {(['chat', 'grid', 'home'] as const).map((kind, index) => (
        <button
          key={kind}
          type="button"
          aria-label={['对话', '工作区', '猫猫家园'][index]}
          className={`grid h-9 w-9 place-items-center rounded-xl ${index === 0 ? 'bg-[var(--console-active-bg)] text-cafe-accent' : 'text-cafe-muted'}`}
        >
          <NavGlyph kind={kind} />
        </button>
      ))}
    </nav>
  );
}
