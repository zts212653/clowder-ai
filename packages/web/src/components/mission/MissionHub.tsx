'use client';

export function MissionHub() {
  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]" data-testid="mission-hub">
      <div className="flex flex-1 flex-col m-3 mt-2 rounded-2xl bg-[var(--console-card-bg)] shadow-[var(--console-shadow-soft)] overflow-hidden">
        <header className="flex items-center gap-3 border-b border-[var(--console-border-soft)] px-5 py-3">
          <h1 className="text-lg font-bold text-cafe">Mission Hub</h1>
        </header>

        <main className="flex-1 overflow-y-auto p-8">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-12 w-12 text-cafe-muted mb-4"
            >
              <path
                d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M15 3v4a1 1 0 0 0 1 1h4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9 13h6" strokeLinecap="round" />
              <path d="M9 17h3" strokeLinecap="round" />
            </svg>
            <p className="text-lg font-semibold text-cafe-secondary">Coming Soon</p>
            <p className="mt-2 text-sm text-cafe-muted max-w-sm">
              Mission Hub will provide a centralized view of tasks, plans, and ongoing missions across your AI team.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
