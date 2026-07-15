import { z } from 'zod';

// ── Response field mapping (JSONPath expressions) ──

/** Only valid terminal/intermediate task states are accepted as statusMap keys. */
const TaskStatusKeySchema = z.enum(['queued', 'running', 'succeeded', 'failed']);

const ResponseMappingSchema = z.object({
  taskId: z.string().optional(),
  status: z.string().optional(),
  statusMap: z.record(TaskStatusKeySchema, z.array(z.string())).optional(),
  resultUrl: z.string().optional(),
  coverUrl: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  codeField: z.string().optional(),
  successCode: z.number().optional(),
  fallbackResultUrl: z.string().optional(),
});

// ── Endpoint definitions ──

const EndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  path: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  response: ResponseMappingSchema,
});

const PollSchema = EndpointSchema.extend({
  interval: z.number().min(1000).default(5000),
  maxAttempts: z.number().min(1).default(120),
  inherit: z.string().optional(),
});

// ── Capability (per-action definition within a protocol) ──

const CapabilitySchema = z.object({
  submit: EndpointSchema.optional(),
  poll: PollSchema.optional(),
  request: EndpointSchema.optional(),
  override: z.record(z.unknown()).optional(),
  inherit: z.string().optional(),
});

// ── Protocol template (loaded from YAML) ──

export const ProtocolTemplateSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().min(1),
  mode: z.enum(['async', 'sync']),
  baseUrl: z.string().url().optional(),
  auth: z
    .object({
      method: z.enum(['apikey', 'query-param', 'jwt-hs256', 'hmac-sha256-v4']).optional(),
      // WHATWG URLSearchParams-stable chars only (a-z A-Z 0-9 _ . * -).
      // RFC 3986 unreserved `~` is NOT stable: URLSearchParams encodes it as %7E.
      paramName: z
        .string()
        .regex(/^[a-zA-Z0-9_.*-]+$/, 'paramName must be URL-safe')
        .optional(),
    })
    .optional(),
  capabilities: z.record(CapabilitySchema),
});

export type ProtocolTemplate = z.infer<typeof ProtocolTemplateSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type PollEndpoint = z.infer<typeof PollSchema>;
export type ResponseMapping = z.infer<typeof ResponseMappingSchema>;

// ── Auth types ──

export type AuthType = 'apikey' | 'jwt-hs256' | 'hmac-sha256-v4' | 'query-param';

export interface AuthResult {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  /** Derived values that must be scrubbed from provider output (JWT, HMAC sig, etc.). */
  sensitiveArtifacts?: string[];
}

export interface AuthStrategy {
  type: AuthType;
  sign(credentials: Record<string, string>, request: { method: string; url: string; body?: string }): AuthResult;
}

// ── Provider instance (user config from .cat-cafe/) ──

export interface ProviderInstance {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  authType: AuthType;
  model?: string;
}

// ── Engine execution types ──

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface SubmitResult {
  taskId: string;
  status: TaskStatus;
}

export interface PollResult {
  status: TaskStatus;
  resultUrl?: string;
  coverUrl?: string;
  error?: string;
}

export interface SyncResult {
  result: string;
}

export interface ExecutionParams {
  provider: ProviderInstance;
  capability: string;
  credentials: Record<string, string>;
  vars: Record<string, string>;
}
