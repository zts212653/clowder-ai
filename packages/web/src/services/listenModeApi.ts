import type { ListenDocumentIdentity, ListenDocumentState } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export interface SynthesizedListenAsset {
  audioUrl: string;
  assetId: string;
  cached: boolean;
  bytes: number;
  durationSec?: number;
  synthesisMs?: number;
}

export interface LoadedListenDocument extends ListenDocumentState {
  cache?: { cachedSentences: number; totalSentences: number; totalBytes: number };
}

export type ListenSynthesisEvent =
  | {
      type: 'chunk';
      audioBase64: string;
      format: string;
      durationSec?: number;
      isFinalChunk: boolean;
    }
  | ({ type: 'asset' } & SynthesizedListenAsset);

export interface ListenModeApi {
  load(identity: Pick<ListenDocumentIdentity, 'projectPath' | 'relativePath'>): Promise<LoadedListenDocument | null>;
  save(state: ListenDocumentState): Promise<void>;
  stream(text: string, signal?: AbortSignal): AsyncIterable<ListenSynthesisEvent>;
  linkAsset(identity: ListenDocumentIdentity, anchor: string, assetId: string): Promise<void>;
  clearAudio(identity: ListenDocumentIdentity): Promise<void>;
}

async function requireOk(response: Response, fallback: string): Promise<Response> {
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
  throw new Error(body?.detail ?? body?.error ?? `${fallback} (${response.status})`);
}

function parseListenSynthesisEvent(block: string): ListenSynthesisEvent | null {
  const data = block
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  if (!data) return null;
  const event = JSON.parse(data) as ListenSynthesisEvent | { type: 'error'; error?: string };
  if (event.type === 'error') throw new Error(event.error ?? '生成语音失败');
  return event;
}

export async function* readListenSynthesisEvents(response: Response): AsyncIterable<ListenSynthesisEvent> {
  if (!response.body) throw new Error('语音流没有响应正文');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        const event = parseListenSynthesisEvent(block);
        if (event) yield event;
      }
      if (done) break;
    }
    const finalEvent = parseListenSynthesisEvent(buffered);
    if (finalEvent) yield finalEvent;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const listenModeApi: ListenModeApi = {
  async load(identity) {
    const params = new URLSearchParams(identity);
    const response = await apiFetch(`/api/tts/listen/document?${params}`);
    if (response.status === 404) return null;
    await requireOk(response, '读取听读进度失败');
    return (await response.json()) as ListenDocumentState;
  },

  async save(state) {
    await requireOk(
      await apiFetch('/api/tts/listen/document', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      }),
      '保存听读进度失败',
    );
  },

  async *stream(text, signal) {
    const response = await requireOk(
      await apiFetch('/api/tts/listen/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      }),
      '生成语音失败',
    );
    yield* readListenSynthesisEvents(response);
  },

  async linkAsset(identity, anchor, assetId) {
    await requireOk(
      await apiFetch('/api/tts/listen/document/asset', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: identity.projectPath,
          relativePath: identity.relativePath,
          anchor,
          assetId,
        }),
      }),
      '关联听读缓存失败',
    );
  },

  async clearAudio(identity) {
    await requireOk(
      await apiFetch('/api/tts/listen/document/audio', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: identity.projectPath, relativePath: identity.relativePath }),
      }),
      '清理听读缓存失败',
    );
  },
};
