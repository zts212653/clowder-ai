import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { type ComposerDraft, readDraft } from './composer-draft.js';
import { applyComposerTranscript, updateComposerVoice } from './composer-voice-draft.js';
import {
  type ComposerVoiceHost,
  ComposerVoiceSession,
  cancelComposerVoice,
  composerVoiceSession,
  detachComposerVoiceHost,
  voiceFileNamespace,
} from './composer-voice-session.js';
import { useMessageExpression } from './message-expression-context.js';
import { discardPendingAttachmentFiles, pendingAttachmentFiles } from './pending-attachment-files.js';
import { useDeviceVoiceService } from './use-device-voice-service.js';
import type { useServiceComposerDraft } from './use-service-composer-draft.js';

export function useComposerVoice(input: {
  namespace: string;
  draftKey: string;
  channelId: string;
  rootEventId?: string;
  language: 'zh' | 'en';
  draft: ComposerDraft;
  setDraft: Dispatch<SetStateAction<ComposerDraft>>;
  durable: ReturnType<typeof useServiceComposerDraft>;
}) {
  const port = useMessageExpression();
  const device = useDeviceVoiceService(input.namespace);
  const [notice, setNotice] = useState<string>();
  const [audioUrl, setAudioUrl] = useState<string>();
  const [duration, setDuration] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const transition = useRef<string>();
  const current = useRef(input);
  current.current = input;
  const scope = useMemo(() => ({ draftKey: input.draftKey, port }), [input.draftKey, port]);
  const currentScope = useRef<typeof scope>();
  currentScope.current = scope;
  const host = useMemo<ComposerVoiceHost>(
    () => ({
      draft: () => (currentScope.current === scope ? current.current.draft : readDraft(scope.draftKey)),
      edit: (transform) => {
        if (currentScope.current === scope) current.current.setDraft(transform);
      },
      flush: (draft) =>
        currentScope.current === scope ? current.current.durable.flush(draft) : Promise.resolve(undefined),
      accept: (result) => {
        if (currentScope.current === scope) current.current.durable.acceptExternal(result);
      },
      notice: (message) => {
        if (currentScope.current === scope) setNotice(message);
      },
    }),
    [scope],
  );
  const captureId = input.draft.voiceDraft?.captureId;
  const state = input.draft.voiceDraft?.state;
  useEffect(() => {
    currentScope.current = scope;
    const stop = () => detachComposerVoiceHost(scope.draftKey, host);
    window.addEventListener('pagehide', stop);
    return () => {
      if (currentScope.current === scope) currentScope.current = undefined;
      window.removeEventListener('pagehide', stop);
      detachComposerVoiceHost(scope.draftKey, host);
    };
  }, [scope, host]);
  useEffect(() => {
    if (captureId) {
      const existing = composerVoiceSession(scope.draftKey, captureId);
      existing?.attach(host);
      if (!existing && (state === 'recording' || state === 'transcribing'))
        input.setDraft((draft) => updateComposerVoice(draft, captureId, { state: 'failed' }));
    }
  }, [scope, captureId, host, input.setDraft]);
  useEffect(() => {
    if (state !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => setDuration(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state, captureId]);
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setAudioUrl(undefined);
    if (captureId && (state === 'ready' || state === 'failed'))
      void pendingAttachmentFiles(voiceFileNamespace(scope.draftKey))
        .then((items) => {
          const file = items.find((item) => item.id === captureId)?.file;
          if (abort.signal.aborted || !file) return;
          url = URL.createObjectURL(file);
          setAudioUrl(url);
        })
        .catch(() => host.notice('录音暂时无法读取；请保留当前页面。'));
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [scope, captureId, state, host]);
  const makeSession = (id: string, service: NonNullable<typeof device.service>) =>
    new ComposerVoiceSession(
      {
        draftKey: input.draftKey,
        captureId: id,
        channelId: input.channelId,
        rootEventId: input.rootEventId,
        port: port!,
        service,
        language: input.language,
        fallbackAccept: input.durable.acceptExternal,
      },
      host,
    );
  return {
    device,
    notice,
    audioUrl,
    duration,
    draft: input.draft.voiceDraft,
    available: Boolean(
      device.service && port && typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia,
    ),
    busy: state === 'recording' || state === 'transcribing',
    blocksSend: transitioning || Boolean(input.draft.voiceDraft && !input.draft.voiceDraft.applied),
    ready: input.durable.ready && !input.durable.conflict && !transitioning,
    async start() {
      if (
        !device.service ||
        !port ||
        input.draft.voiceDraft ||
        !input.durable.ready ||
        input.durable.conflict ||
        transition.current
      )
        return;
      const id = crypto.randomUUID();
      transition.current = id;
      setTransitioning(true);
      const voiceDraft = { captureId: id, state: 'recording' as const, applied: false };
      const draft = { ...input.draft, voiceDraft };
      const session = makeSession(id, device.service);
      input.setDraft(draft);
      setDuration(0);
      setNotice(undefined);
      try {
        await input.durable.flush(draft);
        if (currentScope.current !== scope) session.capture.stop();
        await session.start();
      } catch (error) {
        session.cancel();
        host.edit((draft) => updateComposerVoice(draft, id, { state: 'failed' }));
        host.notice(error instanceof Error ? error.message : String(error));
      } finally {
        if (transition.current === id) {
          transition.current = undefined;
          if (currentScope.current === scope) setTransitioning(false);
        }
      }
    },
    stop() {
      if (captureId) composerVoiceSession(input.draftKey, captureId)?.capture.stop();
    },
    async retry() {
      if (
        !captureId ||
        !device.service ||
        !port ||
        composerVoiceSession(input.draftKey, captureId) ||
        transition.current
      )
        return;
      const ticket = `retry:${captureId}`;
      transition.current = ticket;
      setTransitioning(true);
      try {
        const file = (await pendingAttachmentFiles(voiceFileNamespace(input.draftKey))).find(
          (item) => item.id === captureId,
        )?.file;
        if (!file)
          throw new Error(input.language === 'en' ? 'This recording is not on this device' : '这段录音不在这台设备上');
        const draft = updateComposerVoice(current.current.draft, captureId, { state: 'transcribing' });
        await input.durable.flush(draft);
        const session = makeSession(captureId, device.service);
        if (currentScope.current !== scope) session.detach(host);
        else host.edit((current) => updateComposerVoice(current, captureId, { state: 'transcribing' }));
        void session.transcribe(file);
      } catch (error) {
        host.notice(String(error));
      } finally {
        if (transition.current === ticket) {
          transition.current = undefined;
          if (currentScope.current === scope) setTransitioning(false);
        }
      }
    },
    insert() {
      const voice = current.current.draft.voiceDraft;
      if (voice?.transcript) host.edit((draft) => applyComposerTranscript(draft, voice.captureId, voice.transcript!));
    },
    async cancel() {
      if (!captureId) return;
      const ticket = `cancel:${captureId}`;
      transition.current = ticket;
      setTransitioning(true);
      composerVoiceSession(input.draftKey, captureId)?.cancel();
      const removal = discardPendingAttachmentFiles(voiceFileNamespace(input.draftKey), [captureId]);
      host.edit((draft) => (draft.voiceDraft?.captureId === captureId ? { ...draft, voiceDraft: undefined } : draft));
      try {
        await removal;
        if (port) host.accept(await cancelComposerVoice(port, input.channelId, input.rootEventId, captureId));
      } catch (error) {
        host.notice(String(error));
      } finally {
        if (transition.current === ticket) {
          transition.current = undefined;
          if (currentScope.current === scope) setTransitioning(false);
        }
      }
    },
    async confirm(sent: ComposerDraft) {
      if (sent.voiceDraft)
        await discardPendingAttachmentFiles(voiceFileNamespace(input.draftKey), [sent.voiceDraft.captureId]);
    },
  };
}
