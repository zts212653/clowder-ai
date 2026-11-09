import { z } from 'zod';

const file = z.object({ path: z.string().min(1), filename: z.string().optional(), contentType: z.string().optional() });
const field = z.union([z.string(), z.number().finite(), z.boolean(), z.object({ fromFile: z.string().min(1) })]);
export const platformRequestSchema = z.object({
  accountRef: z.string().min(1).max(160),
  request: z.object({
    method: z.enum(['GET', 'POST', 'DELETE']),
    path: z.string().min(1).max(8192),
    headers: z.record(z.string()).optional(),
    contentType: z.string().optional(),
    body: z.unknown().optional(),
    fields: z.record(z.union([field, z.array(field)])).optional(),
    files: z.record(z.union([file, z.array(file)])).optional(),
  }),
  timeoutMs: z.number().int().min(1000).max(900_000).default(300_000),
  maxResponseBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024)
    .default(128 * 1024 * 1024),
});
export type PlatformRequest = z.infer<typeof platformRequestSchema>;
export function parsePlatformRequest(value: unknown): PlatformRequest {
  const parsed = platformRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid platform request envelope');
  const input = parsed.data;
  assertInferencePath(input.request.method, input.request.path);
  if (
    input.request.method !== 'POST' &&
    (input.request.body !== undefined || input.request.fields || input.request.files)
  )
    throw new Error('GET and DELETE platform requests must not contain a body');
  return input;
}
export interface PlatformRequestReceipt {
  callId: string;
  accountRef: string;
  provider: 'openai';
  method: string;
  path: string;
  model: string | null;
  status: 'completed' | 'http_error' | 'unconfirmed';
  startedAt: string;
  durationMs: number;
  timeoutMs: number;
  httpStatus: number | null;
  requestId: string | null;
  contentType: string | null;
  responseHeaders: Record<string, string> | null;
  responseFile: string | null;
  responseBytes: number;
  responseSha256: string | null;
  receiptFile: string;
  usage: unknown;
  cost: null;
  error: string | null;
}

/** API families, not model/parameter whitelists. No key, organization, billing or training administration. */
export function assertInferencePath(method: string, path: string): void {
  if (!path.startsWith('/v1/') || /[\\#\r\n\0]/u.test(path)) throw new Error('Unsupported platform API path');
  const pathname = path.split('?', 1)[0];
  const decoded = decodeURIComponent(pathname);
  if (decoded !== pathname || decoded.split('/').some((x) => x === '.' || x === '..'))
    throw new Error('Platform API path must be canonical');
  const post =
    /^\/v1\/(?:responses|chat\/completions|completions|decisions|embeddings|moderations|images\/(?:generations|edits|variations)|audio\/(?:speech|transcriptions|translations)|files|uploads|uploads\/[^/]+\/(?:parts|complete|cancel)|videos|videos\/[^/]+\/remix)$/u;
  const get =
    /^\/v1\/(?:models(?:\/[^/]+)?|responses\/[^/]+|chat\/completions\/[^/]+|files(?:\/[^/]+(?:\/content)?)?|videos(?:\/[^/]+(?:\/content)?)?)$/u;
  const remove = /^\/v1\/files\/[^/]+$/u;
  if (!(method === 'POST' ? post : method === 'GET' ? get : remove).test(pathname))
    throw new Error('Platform API path is outside inference and file access');
}
