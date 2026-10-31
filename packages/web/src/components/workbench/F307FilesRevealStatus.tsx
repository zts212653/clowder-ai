import { type FilesRevealState, revealDisplayPath } from './files-tree';

/** Where a requested reveal stands, above the tree: locating, located, or the owner's reason it cannot be shown. */
export function F307FilesRevealStatus({ reveal }: { reveal: FilesRevealState }) {
  if (reveal.status === 'idle') return null;
  if (reveal.status === 'failed') {
    return (
      <p
        role="alert"
        data-testid="f307-files-reveal"
        data-reveal-status="failed"
        className="border-b border-[var(--semantic-critical)]/30 bg-[var(--semantic-critical-surface)] px-3 py-2 text-xs text-conn-red-text"
      >
        {reveal.reason}
      </p>
    );
  }
  return (
    <output
      data-testid="f307-files-reveal"
      data-reveal-status={reveal.status}
      className="block truncate border-b border-cafe-subtle/40 px-3 py-1.5 font-mono text-micro text-cafe-interactive/70"
      title={revealDisplayPath(reveal.path)}
    >
      {reveal.status === 'revealed'
        ? `已定位：${revealDisplayPath(reveal.path)}`
        : `正在定位 ${revealDisplayPath(reveal.path)}…`}
    </output>
  );
}
