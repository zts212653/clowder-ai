import type { TtsStreamEvent, TtsStreamRequest } from '@cat-cafe/shared';
import { apiFetch } from './api-client';

export async function* streamTts(request: TtsStreamRequest, signal?: AbortSignal): AsyncGenerator<TtsStreamEvent> {
  const response = await apiFetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'unknown');
    throw new Error(`TTS stream failed: ${response.status} ${detail}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('ReadableStream not available');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;

      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;

        const event: TtsStreamEvent = JSON.parse(dataLine.slice(6));

        if (event.type === 'error') {
          throw new Error(event.error ?? 'TTS stream error');
        }

        yield event;

        if (event.type === 'done') return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function base64ToBlob(base64: string, mimeType = 'audio/wav'): Blob {
  const byteString = atob(base64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
