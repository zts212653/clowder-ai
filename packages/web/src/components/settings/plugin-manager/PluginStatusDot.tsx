const tones = {
  muted: 'bg-[var(--cafe-text-muted)]',
  warning: 'bg-conn-amber-text',
  update: 'bg-conn-blue-text',
};

/** Redundant visual status: the adjacent label always carries the meaning. */
export function PluginStatusDot({ tone, className = 'h-1.5 w-1.5' }: { tone: keyof typeof tones; className?: string }) {
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded-full ${tones[tone]} ${className}`} />;
}
