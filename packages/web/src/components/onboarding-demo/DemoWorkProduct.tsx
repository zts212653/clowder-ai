import { BrowserPanel } from '../workspace/BrowserPanel';
import type { DemoArtifact } from './demo-story';

export function DemoWorkProduct({ stage, onReady }: { stage?: DemoArtifact; onReady: () => void }) {
  return (
    <aside
      aria-label="逐步完善的成果"
      className="min-h-0 min-w-0 border-t border-[var(--console-border-soft)] md:border-l md:border-t-0"
    >
      <BrowserPanel bundledPage="onboarding-todo" bundledStage={stage ?? 'waiting'} onBundledReady={onReady} />
    </aside>
  );
}
