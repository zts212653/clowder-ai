import { memoryOwnerRevisionSchema } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { eventCorrectionProjection, hasValidEventCorrections } from './event-correction-read';
import { isMemoryEvent, type MemoryEvent, memoryObject } from './owner-memory-read';

export async function readEvent(id: string, signal: AbortSignal, afterCurrentGet = false): Promise<MemoryEvent> {
  signal.throwIfAborted();
  const path = `/api/memory/events/${encodeURIComponent(id)}`;
  const response = await apiFetch(path, { signal }, { afterCurrentGet });
  if (!response.ok) throw new Error('Event unavailable');
  const body: unknown = await response.json();
  signal.throwIfAborted();
  if (isMemoryEvent(body) && body.eventId === id) return body;
  if (
    !memoryObject(body) ||
    body.oversized !== true ||
    body.eventId !== id ||
    !memoryOwnerRevisionSchema.safeParse(body.revision).success ||
    typeof body.eventChars !== 'number' ||
    !Number.isSafeInteger(body.eventChars) ||
    body.eventChars <= 0 ||
    body.eventChars > 6_100_000 ||
    !hasValidEventCorrections(body)
  )
    throw new Error('Event unavailable');
  let offset = 0;
  let serialized = '';
  while (offset < body.eventChars) {
    signal.throwIfAborted();
    const part = await apiFetch(
      `${path}?charOffset=${offset}&revision=${encodeURIComponent(String(body.revision))}`,
      { signal },
      { afterCurrentGet },
    );
    if (!part.ok) throw new Error('Event unavailable');
    const slice: unknown = await part.json();
    signal.throwIfAborted();
    if (
      !memoryObject(slice) ||
      slice.revision !== body.revision ||
      slice.charOffset !== offset ||
      slice.totalChars !== body.eventChars ||
      typeof slice.eventSlice !== 'string' ||
      !slice.eventSlice.length
    )
      throw new Error('Event unavailable');
    serialized += slice.eventSlice;
    offset += slice.eventSlice.length;
    if (serialized.length > body.eventChars) throw new Error('Event changed while reading');
  }
  const event: unknown = JSON.parse(serialized);
  if (!isMemoryEvent(event) || event.eventId !== id || event.revision !== body.revision)
    throw new Error('Event unavailable');
  return { ...event, ...eventCorrectionProjection(body) };
}
