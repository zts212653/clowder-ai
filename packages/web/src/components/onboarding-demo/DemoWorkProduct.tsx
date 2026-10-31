import { useShellCopy } from '../shell/shell-copy';
import { BrowserPanel } from '../workspace/BrowserPanel';
import type { DemoArtifact } from './demo-story';
import { onboardingPlayerCopy } from './onboarding-player.shell-copy';

export function DemoWorkProduct({ stage, onReady }: { stage?: DemoArtifact; onReady: () => void }) {
  const t = useShellCopy(onboardingPlayerCopy);
  return (
    <aside
      aria-label={t.result}
      className="min-h-0 min-w-0 border-t border-[var(--console-border-soft)] md:border-l md:border-t-0"
    >
      <BrowserPanel bundledPage="onboarding-todo" bundledStage={stage ?? 'waiting'} onBundledReady={onReady} />
    </aside>
  );
}
