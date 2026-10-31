import { useEffect, useRef, useState } from 'react';
import type { BootstrapProgress, IndexState, ProjectSummary } from '@/hooks/useIndexState';
import { BootstrapAutoNotice } from './BootstrapAutoNotice';
import { BootstrapProgressPill } from './BootstrapProgressPill';
import { BootstrapPromptCard } from './BootstrapPromptCard';
import { BootstrapSummaryCard } from './BootstrapSummaryCard';

interface BootstrapOrchestratorProps {
  projectPath: string;
  indexState: IndexState;
  isSnoozed: boolean;
  progress: BootstrapProgress | null;
  summary: ProjectSummary | null;
  durationMs?: number | null;
  isNewProject?: boolean;
  governanceDone?: boolean;
  onStartBootstrap: () => void;
  onSnooze: () => void;
  onSearchKnowledge?: () => void;
  onGoToMemoryHub?: () => void;
}

export function BootstrapOrchestrator({
  projectPath,
  indexState,
  isSnoozed,
  progress,
  summary,
  durationMs,
  isNewProject,
  governanceDone,
  onStartBootstrap,
  onSnooze,
  onSearchKnowledge,
  onGoToMemoryHub,
}: BootstrapOrchestratorProps) {
  const [dismissed, setDismissed] = useState(false);
  const autoStartedRef = useRef(false);

  // P2 fix: reset auto-start flag on project switch to prevent cross-project leak
  const prevProjectRef = useRef(projectPath);
  useEffect(() => {
    if (projectPath !== prevProjectRef.current) {
      prevProjectRef.current = projectPath;
      autoStartedRef.current = false;
      setDismissed(false);
    }
  }, [projectPath]);

  // AC-B9: Auto-start bootstrap for new projects after governance completes
  useEffect(() => {
    if (isNewProject && governanceDone && indexState.status === 'missing' && !isSnoozed && !autoStartedRef.current) {
      autoStartedRef.current = true;
      onStartBootstrap();
    }
  }, [isNewProject, governanceDone, indexState.status, isSnoozed, onStartBootstrap]);

  if (dismissed) return null;

  if (indexState.status === 'building' && progress) {
    return autoStartedRef.current ? (
      <>
        <BootstrapAutoNotice />
        <BootstrapProgressPill progress={progress} />
      </>
    ) : (
      <BootstrapProgressPill progress={progress} />
    );
  }

  if (indexState.status === 'ready' && summary) {
    return (
      <BootstrapSummaryCard
        summary={summary}
        docsIndexed={indexState.docs_indexed}
        durationMs={durationMs ?? undefined}
        onDismiss={() => setDismissed(true)}
        onSearchKnowledge={onSearchKnowledge}
        onGoToMemoryHub={onGoToMemoryHub}
      />
    );
  }

  if (indexState.status === 'missing' || indexState.status === 'stale' || indexState.status === 'failed') {
    // P1 fix: auto-notice only for missing state — failed/stale must show actionable PromptCard
    if (indexState.status === 'missing' && isNewProject && governanceDone) return <BootstrapAutoNotice />;
    return (
      <BootstrapPromptCard
        indexState={indexState}
        isSnoozed={isSnoozed}
        projectPath={projectPath}
        onStartScan={onStartBootstrap}
        onSnooze={onSnooze}
      />
    );
  }

  return null;
}
