import type { ContextAttachment, MessageWorkDisposition } from '@cat-cafe/shared';
import type { WhisperOptions } from '@/hooks/useSendMessage';

export interface PendingNewConversationIntent {
  v: 1;
  createIdempotencyKey: string;
  messageIdempotencyKey: string;
  projectPath?: string;
  preferredCats: string[];
  title?: string;
  pinned?: boolean;
  sessionImport?: { sessionId: string; catId: string; projectPath: string; firstPrompt: string };
  importAccepted?: boolean;
  creationStarted: boolean;
  createdThreadId?: string;
  messageAccepted?: boolean;
  composerDraftAdmission?: {
    threadId: 'default';
    expectedRevision: number;
  };
}

export interface FirstMessagePayload {
  content: string;
  images?: File[];
  whisper?: WhisperOptions;
  explicitTargetCats?: string[];
  replyToId?: string;
  messageDisposition?: MessageWorkDisposition;
  contextAttachments?: ContextAttachment[];
}

export type FirstMessageAdmissionPhase =
  | 'idle'
  | 'creating'
  | 'sending'
  | 'draft_recovered'
  | 'draft_recovery_blocked'
  | 'create_failed'
  | 'create_rejected'
  | 'send_failed'
  | 'import_failed'
  | 'complete';

export interface FirstMessageAdmissionDependencies {
  readIntent: () => PendingNewConversationIntent;
  persistIntent: (intent: PendingNewConversationIntent) => Promise<void>;
  createThread: (intent: PendingNewConversationIntent) => Promise<{ id: string }>;
  sendMessage: (payload: FirstMessagePayload, threadId: string, messageIdempotencyKey: string) => Promise<boolean>;
  complete: (threadId: string) => Promise<void>;
  navigate: (threadId: string) => void;
  onPhaseChange?: (phase: FirstMessageAdmissionPhase) => void;
}

export interface FirstMessageAdmissionController {
  send: (payload: FirstMessagePayload) => Promise<boolean>;
}

interface ResolvedFirstMessageIntent {
  intent: PendingNewConversationIntent;
  threadId: string;
}

type PhaseReporter = (phase: FirstMessageAdmissionPhase) => void;

function optionsMayChangeAfter(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'optionsMayChange' in error &&
    (error as { optionsMayChange?: unknown }).optionsMayChange === true
  );
}

export async function resolveNewConversationThread(
  dependencies: Pick<FirstMessageAdmissionDependencies, 'readIntent' | 'persistIntent' | 'createThread'>,
  setPhase: PhaseReporter,
): Promise<ResolvedFirstMessageIntent | null> {
  let intent = dependencies.readIntent();
  if (intent.createdThreadId) return { intent, threadId: intent.createdThreadId };

  setPhase('creating');
  try {
    if (!intent.creationStarted) {
      intent = { ...intent, creationStarted: true };
      await dependencies.persistIntent(intent);
    }
    const created = await dependencies.createThread(intent);
    const threadId = created.id.trim();
    if (!threadId) throw new Error('thread creation returned an empty id');
    intent = { ...intent, creationStarted: true, createdThreadId: threadId };
    // A known thread is the recovery boundary. Persist it before the first
    // message so a failed send or refresh never creates another thread.
    await dependencies.persistIntent(intent);
    return { intent, threadId };
  } catch (error) {
    if (optionsMayChangeAfter(error)) {
      try {
        await dependencies.persistIntent({ ...intent, creationStarted: false });
      } catch {
        // The page still reports the create failure; a durable retry keeps the
        // previous locked request if this local recovery write did not land.
      }
      setPhase('create_rejected');
      return null;
    }
    setPhase('create_failed');
    return null;
  }
}

async function deliverFirstMessage(
  dependencies: FirstMessageAdmissionDependencies,
  resolved: ResolvedFirstMessageIntent,
  payload: FirstMessagePayload,
  setPhase: PhaseReporter,
): Promise<boolean> {
  setPhase('sending');
  try {
    const accepted = await dependencies.sendMessage(payload, resolved.threadId, resolved.intent.messageIdempotencyKey);
    if (accepted) return true;
  } catch {
    // A stable message key makes an ambiguous failure safe to retry.
  }
  setPhase('send_failed');
  return false;
}

async function finishAcceptedMessage(
  dependencies: FirstMessageAdmissionDependencies,
  resolved: ResolvedFirstMessageIntent,
  setPhase: PhaseReporter,
): Promise<void> {
  if (!resolved.intent.messageAccepted) {
    try {
      await dependencies.persistIntent({ ...resolved.intent, messageAccepted: true });
    } catch {
      // The stable message key remains the fallback if both persistence and cleanup fail.
    }
  }
  try {
    await dependencies.complete(resolved.threadId);
  } catch {
    // The accepted marker lets a later visit retry cleanup without resending.
  }
  setPhase('complete');
  dependencies.navigate(resolved.threadId);
}

export function createFirstMessageAdmissionController(
  dependencies: FirstMessageAdmissionDependencies,
): FirstMessageAdmissionController {
  let inFlight: Promise<boolean> | null = null;
  let completedThreadId: string | null = null;

  const setPhase = (phase: FirstMessageAdmissionPhase) => dependencies.onPhaseChange?.(phase);

  const admit = async (payload: FirstMessagePayload): Promise<boolean> => {
    if (dependencies.readIntent().sessionImport) return false;
    const resolved = await resolveNewConversationThread(dependencies, setPhase);
    if (!resolved) return false;
    if (!resolved.intent.messageAccepted) {
      const accepted = await deliverFirstMessage(dependencies, resolved, payload, setPhase);
      if (!accepted) return false;
    }
    await finishAcceptedMessage(dependencies, resolved, setPhase);
    completedThreadId = resolved.threadId;
    return true;
  };

  return {
    send: (payload) => {
      if (completedThreadId) return Promise.resolve(true);
      if (inFlight) return inFlight;
      const request = admit(payload);
      inFlight = request;
      void request.finally(() => {
        if (inFlight === request) inFlight = null;
      });
      return request;
    },
  };
}
