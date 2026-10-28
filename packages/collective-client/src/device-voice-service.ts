/** An explicit current-Human device setting, never the central Service or another person's Café endpoint. */
export function deviceVoiceEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use the address of an existing transcription service on this device');
  return url.href.replace(/\/$/u, '');
}

export interface DeviceVoiceService {
  readonly endpoint: string;
  transcribe(recording: Blob, language: 'zh' | 'en', signal: AbortSignal): Promise<string>;
}
export async function connectDeviceVoiceService(value: string, signal: AbortSignal): Promise<DeviceVoiceService> {
  const endpoint = deviceVoiceEndpoint(value);
  const response = await fetch(`${endpoint}/health`, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error('Transcription service is unavailable');
  const health: unknown = await response.json();
  if (!health || typeof health !== 'object' || !('status' in health) || health.status !== 'ok')
    throw new Error('Transcription service is not ready');
  return {
    endpoint,
    async transcribe(recording, language, operationSignal) {
      const form = new FormData();
      form.append('file', recording, recording.type.includes('mp4') ? 'recording.mp4' : 'recording.webm');
      form.append('language', language);
      const result = await fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([operationSignal, AbortSignal.timeout(120_000)]),
      });
      if (!result.ok) throw new Error('Could not transcribe this recording');
      const payload: unknown = await result.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('text' in payload) ||
        typeof payload.text !== 'string' ||
        !payload.text.trim() ||
        payload.text.length > 32_000
      )
        throw new Error('No usable transcription was returned');
      return payload.text.trim();
    },
  };
}
