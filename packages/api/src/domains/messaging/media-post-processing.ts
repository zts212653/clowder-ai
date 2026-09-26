import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import type { MessageElement } from '@clowder-ai/plugin-contract';
import type { FileMessagingMediaLedger } from './media-ledger.js';

export const MEDIA_POST_PROCESS_STAGE_TIMEOUT_MS = 60_000;
const READ_LIMIT = 524_288;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

type ImportedMedia = { elementId: string; hmrId: string; type: string; fileName?: string };
type WarningStage = 'preview' | 'transcription';
type WarningReason = 'timeout' | 'processing_failed';

export interface HostMediaPostProcessorDeps {
  readonly ledger: Pick<FileMessagingMediaLedger, 'readChunk'>;
  readonly privateDir: string;
  readonly sttProvider?: {
    transcribe(request: { audioPath: string; signal?: AbortSignal }): Promise<{ text: string }>;
  };
  readonly stageTimeoutMs?: number;
  readonly now?: () => number;
}

class StageTimedOut extends Error {}

function warning(elementId: string, stage: WarningStage, reason: WarningReason): MessageElement {
  const suffix = createHash('sha256').update(elementId).digest('hex').slice(0, 24);
  return {
    elementId: `media-warning-${stage}-${suffix}`,
    kind: 'media_warning',
    payload: { mediaElementId: elementId, stage, reason },
  };
}

function remainingMs(deadline: number, deps: HostMediaPostProcessorDeps): number {
  return Math.min(deps.stageTimeoutMs ?? MEDIA_POST_PROCESS_STAGE_TIMEOUT_MS, deadline - (deps.now?.() ?? Date.now()));
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new StageTimedOut();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StageTimedOut());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readMedia(ledger: HostMediaPostProcessorDeps['ledger'], hmrId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const result = await ledger.readChunk(hmrId, offset, READ_LIMIT);
    if (!result || result.offset !== offset) throw new Error('Host media is unavailable');
    const bytes = Buffer.from(result.dataBase64, 'base64');
    if (offset + bytes.length > MAX_AUDIO_BYTES) throw new Error('Host media exceeds processing bound');
    chunks.push(bytes);
    if (result.done) return Buffer.concat(chunks);
    if (bytes.length === 0 || result.nextOffset !== offset + bytes.length) {
      throw new Error('Host media made no progress');
    }
    offset = result.nextOffset;
  }
}

async function transcribeAudio(
  media: ImportedMedia,
  deps: HostMediaPostProcessorDeps,
  deadline: number,
): Promise<string> {
  if (!deps.sttProvider) throw new Error('STT provider is unavailable');
  const bytes = await withTimeout(() => readMedia(deps.ledger, media.hmrId), remainingMs(deadline, deps));
  const extension = extname(media.fileName ?? '')
    .toLowerCase()
    .slice(1);
  const safeExtension = ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'webm'].includes(extension) ? extension : 'wav';
  await mkdir(deps.privateDir, { recursive: true, mode: 0o700 });
  const audioPath = join(deps.privateDir, `${randomBytes(16).toString('hex')}.${safeExtension}`);
  const handle = await open(audioPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  try {
    const result = await withTimeout(
      (signal) => deps.sttProvider!.transcribe({ audioPath, signal }),
      remainingMs(deadline, deps),
    );
    return result.text;
  } finally {
    await unlink(audioPath);
  }
}

/** Host-only e2 enrichment. HMR IDs remain identifiers; bytes never enter public uploads. */
export function createHostMediaPostProcessor(deps: HostMediaPostProcessorDeps) {
  return async (
    imported: readonly ImportedMedia[],
    deadline: number,
  ): Promise<{
    warnings: readonly MessageElement[];
    contentBlocks?: readonly MessageContent[];
    transcript?: string;
  }> => {
    const warnings: MessageElement[] = [];
    const contentBlocks: MessageContent[] = [];
    const transcripts: string[] = [];
    for (const media of imported) {
      if (media.type !== 'image' && media.type !== 'audio') continue;
      const stage: WarningStage = media.type === 'image' ? 'preview' : 'transcription';
      try {
        if (media.type === 'image') {
          if (!/^hmr_[A-Za-z0-9_-]{32}$/.test(media.hmrId)) throw new Error('Host image reference is invalid');
          const first = await withTimeout(() => deps.ledger.readChunk(media.hmrId, 0, 1), remainingMs(deadline, deps));
          if (!first?.dataBase64) throw new Error('Host image is empty or unavailable');
          contentBlocks.push({ type: 'image', url: `hmr:${media.hmrId}` });
        } else {
          const transcript = await transcribeAudio(media, deps, deadline);
          if (transcript) transcripts.push(transcript);
        }
      } catch (error) {
        warnings.push(
          warning(media.elementId, stage, error instanceof StageTimedOut ? 'timeout' : 'processing_failed'),
        );
      }
    }
    return {
      warnings,
      ...(contentBlocks.length ? { contentBlocks } : {}),
      ...(transcripts.length ? { transcript: transcripts.join('\n') } : {}),
    };
  };
}
