import type { CollectiveComposerVoiceDraft } from '@cat-cafe/shared';
import { VoiceCapture } from '@cat-cafe/ui';
import { type ComposerDraft, readDraft } from './composer-draft.js';
import { applyComposerTranscript, publishComposerTranscript, updateComposerVoice } from './composer-voice-draft.js';
import type { DeviceVoiceService } from './device-voice-service.js';
import type { MessageExpressionPort } from './message-expression-context.js';
import {
  beginPendingAttachmentFile,
  discardPendingAttachmentFiles,
  hasPendingAttachmentFile,
  savePendingAttachmentFile,
} from './pending-attachment-files.js';

type DraftResult = Awaited<ReturnType<MessageExpressionPort['saveDraft']>>;
export interface ComposerVoiceHost {
  draft(): ComposerDraft;
  edit(transform: (draft: ComposerDraft) => ComposerDraft): void;
  flush(draft: ComposerDraft): Promise<{ revision: number } | undefined>;
  accept(result: DraftResult): void;
  notice(message: string): void;
}
const sessions = new Map<string, ComposerVoiceSession>();
export const voiceFileNamespace = (draftKey: string) => `${draftKey}:voice`;
export const composerVoiceSession = (draftKey: string, captureId: string) => sessions.get(`${draftKey}:${captureId}`);
export function detachComposerVoiceHost(draftKey: string, host: ComposerVoiceHost) {
  for (const session of sessions.values()) if (session.draftKey === draftKey) session.detach(host);
}

/** One fixed Human/Channel recording can finish after navigation. Only that same scope may attach a replacement view. */
export class ComposerVoiceSession {
  readonly draftKey: string;
  readonly capture: VoiceCapture;
  private host?: ComposerVoiceHost;
  private readonly operation = new AbortController();
  private cache = Promise.resolve();
  private finished = false;
  private readonly files: string;
  constructor(
    private readonly input: {
      draftKey: string;
      captureId: string;
      channelId: string;
      rootEventId?: string;
      port: MessageExpressionPort;
      service: DeviceVoiceService;
      language: 'zh' | 'en';
      fallbackAccept: ComposerVoiceHost['accept'];
    },
    host: ComposerVoiceHost,
  ) {
    this.host = host;
    this.draftKey = input.draftKey;
    this.files = voiceFileNamespace(input.draftKey);
    sessions.set(`${input.draftKey}:${input.captureId}`, this);
    beginPendingAttachmentFile(this.files, input.captureId);
    this.capture = new VoiceCapture({
      onChunk: (blob) => {
        this.cache = this.cache
          .then(() =>
            savePendingAttachmentFile(this.files, {
              id: input.captureId,
              file: this.file(blob),
            }),
          )
          .catch((error) => {
            this.host?.notice(String(error));
          });
      },
      onStop: (blob) => {
        void this.transcribe(blob);
      },
      onError: (error) => this.host?.notice(error.message),
    });
  }
  attach(host: ComposerVoiceHost) {
    this.host = host;
  }
  detach(host: ComposerVoiceHost) {
    if (this.host !== host) return;
    this.host = undefined;
    this.capture.stop();
  }
  private present() {
    return hasPendingAttachmentFile(this.files, this.input.captureId) && !this.operation.signal.aborted;
  }
  private file(blob: Blob) {
    return new File([blob], blob.type.includes('mp4') ? 'recording.mp4' : 'recording.webm', { type: blob.type });
  }
  private edit(transform: (draft: ComposerDraft) => ComposerDraft) {
    if (!this.present()) return;
    const value = transform(this.host?.draft() ?? readDraft(this.input.draftKey));
    localStorage.setItem(this.input.draftKey, JSON.stringify(value));
    this.host?.edit(transform);
  }
  private stage(voice: Partial<CollectiveComposerVoiceDraft>) {
    this.edit((draft) => updateComposerVoice(draft, this.input.captureId, voice));
  }
  async start() {
    try {
      if (!(await this.capture.start())) {
        this.stage({ state: 'failed' });
        this.release();
      }
    } catch (error) {
      this.stage({ state: 'failed' });
      this.host?.notice(error instanceof Error ? error.message : String(error));
      this.release();
    }
  }
  async transcribe(blob: Blob) {
    if (this.finished || !this.present()) return;
    this.finished = true;
    let transcript: string | undefined;
    try {
      await this.cache;
      if (!blob.size) throw new Error(this.input.language === 'en' ? 'No audio was recorded' : '尚未录到声音');
      await savePendingAttachmentFile(this.files, { id: this.input.captureId, file: this.file(blob) });
      if (!this.present()) return;
      this.stage({ state: 'transcribing' });
      transcript = await this.input.service.transcribe(blob, this.input.language, this.operation.signal);
      if (!this.present()) return;
      const live = this.host;
      const receipt = live ? await live.flush(live.draft()) : undefined;
      if (!this.present()) return;
      const result = await publishComposerTranscript(
        this.input.port,
        this.input.channelId,
        this.input.rootEventId,
        this.input.captureId,
        transcript,
        receipt?.revision,
      );
      if (!this.present()) return;
      (this.host?.accept ?? this.input.fallbackAccept)(result);
      if (result.status === 'conflict') {
        this.stage({ state: 'ready', transcript, applied: false });
        return;
      }
      if (result.draft.content.voiceDraft?.captureId !== this.input.captureId) return;
      if (this.host) this.edit((draft) => applyComposerTranscript(draft, this.input.captureId, transcript!));
      else localStorage.setItem(this.input.draftKey, JSON.stringify(result.draft.content));
    } catch (error) {
      if (!this.present()) return;
      this.stage({ state: transcript ? 'ready' : 'failed', ...(transcript ? { transcript, applied: false } : {}) });
      this.host?.notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.release();
    }
  }
  cancel() {
    this.operation.abort();
    this.capture.cancel();
    void discardPendingAttachmentFiles(this.files, [this.input.captureId]).catch(() => {});
    this.release();
  }
  private release() {
    sessions.delete(`${this.input.draftKey}:${this.input.captureId}`);
  }
}

/** A cancellation targets the capture identity and preserves any newer capture and independently edited words. */
export async function cancelComposerVoice(
  port: MessageExpressionPort,
  channelId: string,
  rootEventId: string | undefined,
  captureId: string,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { draft } = await port.channelState(channelId, rootEventId);
    if (draft.content.voiceDraft?.captureId !== captureId) return { status: 'stored' as const, draft };
    const { voiceDraft: _voice, ...content } = draft.content;
    const result = await port.saveDraft(channelId, rootEventId, content, draft.revision, `voice:${captureId}:cancel`);
    if (result.status === 'stored' || attempt === 1) return result;
  }
  throw new Error('Voice cancellation did not finish');
}
