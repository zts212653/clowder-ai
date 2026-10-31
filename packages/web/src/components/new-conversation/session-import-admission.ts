import {
  type FirstMessageAdmissionDependencies,
  type PendingNewConversationIntent,
  resolveNewConversationThread,
} from './first-message-admission';

export type SessionImportIntent = NonNullable<PendingNewConversationIntent['sessionImport']>;
export interface SessionImportAdmissionDependencies
  extends Pick<
    FirstMessageAdmissionDependencies,
    'readIntent' | 'persistIntent' | 'createThread' | 'navigate' | 'onPhaseChange'
  > {
  bind: (threadId: string, intent: SessionImportIntent) => Promise<void>;
  complete: () => Promise<void>;
  resetIntent?: () => Promise<void>;
}

/** Durable thread coordinates precede the bind; an ambiguous retry never creates a second thread. */
export function createSessionImportAdmissionController(deps: SessionImportAdmissionDependencies) {
  let inFlight: Promise<void> | null = null;
  const setPhase = (phase: Parameters<NonNullable<typeof deps.onPhaseChange>>[0]) => deps.onPhaseChange?.(phase);
  const run = async (selection: SessionImportIntent) => {
    const current = deps.readIntent();
    if (current.creationStarted && !current.sessionImport) throw new Error('First-message admission already started');
    if (
      current.sessionImport &&
      (current.sessionImport.catId !== selection.catId || current.sessionImport.sessionId !== selection.sessionId)
    ) {
      throw new Error('Retry the originally selected session');
    }
    if (!current.creationStarted) {
      await deps.persistIntent({
        ...current,
        projectPath: selection.projectPath,
        preferredCats: [selection.catId],
        sessionImport: selection,
      });
    }
    const resolved = await resolveNewConversationThread(deps, setPhase);
    if (!resolved) throw new Error('Conversation creation could not be confirmed');
    try {
      await deps.bind(resolved.threadId, selection);
    } catch (error) {
      setPhase('import_failed');
      throw error;
    }
    await deps.persistIntent({ ...deps.readIntent(), importAccepted: true });
    await deps.complete();
    setPhase('complete');
    deps.navigate(resolved.threadId);
  };
  return {
    cancel: async () => {
      if (inFlight) return;
      await deps.resetIntent?.();
      setPhase('idle');
    },
    importSession: (selection: SessionImportIntent): Promise<void> => {
      if (inFlight) return inFlight;
      inFlight = run(selection);
      void inFlight
        .finally(() => {
          inFlight = null;
        })
        .catch(() => {});
      return inFlight;
    },
  };
}
