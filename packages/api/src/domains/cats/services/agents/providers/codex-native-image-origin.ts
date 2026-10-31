import { createHash } from 'node:crypto';
import { MAX_IMAGE_FILE_SIZE } from '../../../../../utils/image-storage.js';

export interface CodexNativeImageOrigin {
  provider: 'codex';
  invocationId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  blobDigest: `sha256:${string}`;
}

/** Supplied by the server-owned invocation archive, never by rich-block provenance or model text. */
export interface CodexNativeImageSource {
  invocationId: string;
  envelopes: readonly unknown[];
}

interface NativeImageOutput {
  sourcePath: string;
  origin: CodexNativeImageOrigin;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rpcId(value: unknown): string | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? JSON.stringify(value)
    : undefined;
}

/** Retain only producer evidence after the original native envelope has been durably archived. */
export function codexImageOriginEnvelope(direction: string, envelope: Record<string, unknown>): unknown {
  const params = object(envelope.params);
  if (direction === 'outbound' && envelope.method === 'turn/start' && rpcId(envelope.id))
    return {
      direction,
      envelope: { id: envelope.id, method: envelope.method, params: { threadId: params?.threadId } },
    };
  if (direction !== 'inbound') return;
  const turn = object(object(envelope.result)?.turn);
  if (rpcId(envelope.id) && typeof turn?.id === 'string' && !envelope.error)
    return { direction, envelope: { id: envelope.id, result: { turn: { id: turn.id } } } };
  const item = object(params?.item);
  if (envelope.method !== 'item/completed' || item?.type !== 'imageGeneration') return;
  return {
    direction,
    envelope: {
      method: envelope.method,
      params: {
        threadId: params?.threadId,
        turnId: params?.turnId,
        item: {
          type: item.type,
          id: item.id,
          status: item.status,
          failure: item.failure,
          savedPath: item.savedPath,
          result: item.result,
        },
      },
    },
  };
}

/** Pair a Host turn/start RPC with its native acceptance before attributing any generated output. */
export function codexNativeImageOutputs(source: CodexNativeImageSource, sessionId: string): NativeImageOutput[] {
  if (!source.invocationId) return [];
  const requests = new Set<string>();
  const turns = new Set<string>();
  for (const raw of source.envelopes) {
    const entry = object(raw);
    const envelope = object(entry?.envelope);
    const id = rpcId(envelope?.id);
    if (!id) continue;
    const params = object(envelope?.params);
    if (entry?.direction === 'outbound' && envelope?.method === 'turn/start' && params?.threadId === sessionId)
      requests.add(id);
    if (entry?.direction === 'inbound' && requests.has(id) && !envelope?.error) {
      const turn = object(object(envelope?.result)?.turn);
      if (typeof turn?.id === 'string') turns.add(turn.id);
    }
  }
  const outputs = new Map<string, NativeImageOutput | null>();
  for (const raw of source.envelopes) {
    const entry = object(raw);
    const envelope = object(entry?.envelope);
    if (entry?.direction !== 'inbound' || envelope?.method !== 'item/completed') continue;
    const params = object(envelope.params);
    const item = object(params?.item);
    if (
      params?.threadId !== sessionId ||
      typeof params.turnId !== 'string' ||
      !turns.has(params.turnId) ||
      item?.type !== 'imageGeneration' ||
      item.status !== 'completed' ||
      item.failure != null ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.savedPath !== 'string' ||
      typeof item.result !== 'string' ||
      !item.result ||
      item.result.length > Math.ceil(MAX_IMAGE_FILE_SIZE / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.result)
    )
      continue;
    const bytes = Buffer.from(item.result, 'base64');
    const output: NativeImageOutput = {
      sourcePath: item.savedPath,
      origin: {
        provider: 'codex',
        invocationId: source.invocationId,
        sessionId,
        turnId: params.turnId,
        itemId: item.id,
        blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    };
    const key = JSON.stringify([params.turnId, item.id]);
    if (outputs.has(key)) {
      if (JSON.stringify(outputs.get(key)) !== JSON.stringify(output)) outputs.set(key, null);
    } else outputs.set(key, output);
  }
  return [...outputs.values()].filter((output): output is NativeImageOutput => output !== null);
}
