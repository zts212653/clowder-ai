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
  provider: PlatformProvider;
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

export type PlatformProvider = 'openai' | 'google';
type Method = PlatformRequest['request']['method'];

const OPENAI_PATHS: Record<Method, RegExp> = {
  POST: /^\/v1\/(?:responses|chat\/completions|completions|decisions|embeddings|moderations|images\/(?:generations|edits|variations)|audio\/(?:speech|transcriptions|translations)|files|uploads|uploads\/[^/]+\/(?:parts|complete|cancel)|videos|videos\/[^/]+\/remix)$/u,
  GET: /^\/v1\/(?:models(?:\/[^/]+)?|responses\/[^/]+|chat\/completions\/[^/]+|files(?:\/[^/]+(?:\/content)?)?|videos(?:\/[^/]+(?:\/content)?)?)$/u,
  DELETE: /^\/v1\/files\/[^/]+$/u,
};
// Vertex AI publisher models, with or without a project/location prefix, their long-running operations and
// Lyria interactions. No endpoints, tuning, datasets, caches, batch jobs or IAM.
const VERTEX = String.raw`\/v1(?:beta1)?\/`;
const SCOPE = String.raw`projects\/[^/:]+\/locations\/[^/:]+\/`;
const MODEL = String.raw`publishers\/google\/models\/[^/:]+`;
const GOOGLE_PATHS: Record<Method, RegExp> = {
  POST: new RegExp(
    `^${VERTEX}(?:(?:${SCOPE})?${MODEL}:(?:generateContent|streamGenerateContent|countTokens|computeTokens|predict|predictLongRunning|fetchPredictOperation)|${SCOPE}interactions)$`,
    'u',
  ),
  GET: new RegExp(
    `^${VERTEX}(?:(?:${SCOPE})?publishers/google/models(?:/[^/:]+)?|${SCOPE}(?:${MODEL}/)?operations/[^/:]+|${SCOPE}interactions/[^/:]+)$`,
    'u',
  ),
  DELETE: /(?!)/u,
};

/** API families, not model/parameter whitelists. No key, organization, billing or training administration. */
export function assertInferencePath(provider: PlatformProvider, method: Method, path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n\0]/u.test(path))
    throw new Error('Unsupported platform API path');
  const pathname = path.split('?', 1)[0];
  const decoded = decodeURIComponent(pathname);
  if (decoded !== pathname || decoded.split('/').some((x) => x === '.' || x === '..'))
    throw new Error('Platform API path must be canonical');
  // Google also accepts ?key=; the host alone authenticates, in a header.
  if (provider === 'google' && new URLSearchParams(path.slice(pathname.length + 1)).has('key'))
    throw new Error('Platform authentication belongs to the host');
  if (!(provider === 'google' ? GOOGLE_PATHS : OPENAI_PATHS)[method].test(pathname))
    throw new Error('Platform API path is outside inference and file access');
}

/** Vertex names the model in the path; OpenAI bodies carry their own. */
export function platformPathModel(provider: PlatformProvider, path: string): string | null {
  return provider === 'google' ? (/\/publishers\/google\/models\/([^/:?]+)/u.exec(path)?.[1] ?? null) : null;
}

/**
 * A Google Cloud login spends one project: the path must name it, and its location picks the Vertex host.
 * Reading the publisher model catalog spends nothing and has no project in its path.
 */
export function googleCloudVertexOrigin(method: Method, path: string, projectId: string): string {
  if (method === 'GET' && /^\/v1(?:beta1)?\/publishers\/google\/models(?:\?|$)/u.test(path))
    return 'https://aiplatform.googleapis.com';
  const scope = /^\/v1(?:beta1)?\/projects\/([^/:]+)\/locations\/([a-z0-9-]+)\//u.exec(path);
  if (!scope || scope[1] !== projectId) throw new Error('Google Cloud requests must name the account project');
  return scope[2] === 'global' ? 'https://aiplatform.googleapis.com' : `https://${scope[2]}-aiplatform.googleapis.com`;
}
