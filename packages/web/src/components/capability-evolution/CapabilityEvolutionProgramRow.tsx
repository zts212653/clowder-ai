import {
  type EvolutionProgramPresentationProjection,
  humanizeEvolutionTarget,
  productStatus,
} from './capability-evolution-presentation';

function CapabilityGlyph({ ownerStateRef }: { ownerStateRef: string }) {
  const kind = ownerStateRef.includes('microduck')
    ? 'robot'
    : ownerStateRef.includes('roadshow')
      ? 'presentation'
      : ownerStateRef.includes('development-process')
        ? 'process'
        : 'evolution';
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'robot' ? (
        <>
          <path d="M6.5 4.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" />
          <path d="M10 2.5v2M7.5 8.5h.01M12.5 8.5h.01M8 11h4M7 13.5v2M13 13.5v2" />
        </>
      ) : kind === 'presentation' ? (
        <>
          <path d="M3.5 4.5h13v9h-13zM7 16.5l3-3 3 3" />
          <path d="M6.5 10.5 9 8l2 1.5 2.5-3" />
        </>
      ) : kind === 'process' ? (
        <>
          <path d="M4 5h7M4 10h12M9 15h7" />
          <circle cx="13.5" cy="5" r="1.5" />
          <circle cx="6.5" cy="15" r="1.5" />
        </>
      ) : (
        <path d="M6 2.5c7 3.5 7 11.5 0 15M14 2.5c-7 3.5-7 11.5 0 15M6.8 5.2h6.4M5.8 10h8.4M6.8 14.8h6.4" />
      )}
    </svg>
  );
}

export function CapabilityEvolutionProgramRow({
  projection,
  selected,
  onSelect,
}: {
  projection: EvolutionProgramPresentationProjection;
  selected: boolean;
  onSelect: () => void;
}) {
  const target = humanizeEvolutionTarget(projection.program.objectRef);
  const status = productStatus(projection);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`capability-evolution-program-${projection.program.programId}`}
      aria-pressed={selected}
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] px-4 py-3.5 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface aria-pressed:border-cafe-accent/45 aria-pressed:bg-cafe-accent/5"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cafe-surface-sunken text-cafe-accent">
        <CapabilityGlyph ownerStateRef={projection.program.objectRef.ownerStateRef} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-cafe-black">{target.title}</span>
        <span className="mt-1 block truncate text-xs text-cafe-muted">{status.description}</span>
      </span>
      <span className="text-right">
        <span className="block rounded-full bg-cafe-surface-sunken px-2.5 py-1 text-micro font-semibold text-cafe-secondary">
          {status.label}
        </span>
        <span className="mt-1.5 block text-micro text-cafe-muted">第 {projection.program.cycle} 轮</span>
      </span>
    </button>
  );
}
