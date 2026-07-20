import { getAuthStrategy } from './auth/index.js';
import { extractString, renderBody, renderTemplate } from './template-utils.js';
import type {
  AuthType,
  Capability,
  Endpoint,
  ExecutionParams,
  PollEndpoint,
  PollResult,
  ProtocolTemplate,
  SubmitResult,
  SyncResult,
  TaskStatus,
} from './types.js';

// ── Credential scrubbing ──

const CREDENTIAL_PLACEHOLDER = '***';

/** Extract secret values from a credentials record, sorted longest-first. */
export function buildSecretsList(credentials: Record<string, string>, authArtifacts?: string[]): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(credentials)) {
    if (key.startsWith('_')) continue;
    if (value && value.length >= 4) secrets.push(value);
  }
  if (authArtifacts) {
    for (const v of authArtifacts) {
      if (v && v.length >= 4 && !secrets.includes(v)) secrets.push(v);
    }
  }
  // Longest first: prevents partial replacement leaving credential suffixes.
  secrets.sort((a, b) => b.length - a.length);
  return secrets;
}

/** Core scrub: replace all known secret values in text (expects pre-sorted array). */
function scrubSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const value of secrets) {
    result = result.replaceAll(value, CREDENTIAL_PLACEHOLDER);
  }
  return result;
}

/** Convenience: scrub text using a raw credentials record (no auth artifacts). */
export function scrubCredentials(text: string, credentials: Record<string, string>): string {
  return scrubSecrets(text, buildSecretsList(credentials));
}

/** Deep-scrub an unknown JSON value, replacing credential substrings in all string leaves. */
function scrubJsonValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrubJsonValue(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubJsonValue(v, secrets);
    }
    return out;
  }
  return value;
}

function resolveCapability(template: ProtocolTemplate, name: string): Capability {
  const cap = template.capabilities[name];
  if (!cap) {
    const available = Object.keys(template.capabilities).join(', ');
    throw new Error(`Capability "${name}" not found. Available: ${available}`);
  }
  return cap;
}

function buildUrl(
  baseUrl: string,
  pathTemplate: string,
  vars: Record<string, string>,
  authQueryParams?: Record<string, string>,
): string {
  const path = renderTemplate(pathTemplate, vars);
  const url = new URL(path, baseUrl);
  if (authQueryParams) {
    for (const [k, v] of Object.entries(authQueryParams)) url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Transient HTTP status codes eligible for retry. */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

interface RequestResult {
  json: unknown;
  secrets: string[];
}

async function executeRequest(
  endpoint: Endpoint,
  baseUrl: string,
  authType: AuthType,
  credentials: Record<string, string>,
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<RequestResult> {
  const body = endpoint.body ? JSON.stringify(renderBody(endpoint.body, vars)) : undefined;
  const url = buildUrl(baseUrl, endpoint.path, vars);

  const auth = getAuthStrategy(authType);
  const authResult = auth.sign(credentials, { method: endpoint.method, url, body });

  const finalUrl = authResult.queryParams ? buildUrl(baseUrl, endpoint.path, vars, authResult.queryParams) : url;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...endpoint.headers,
    ...authResult.headers,
  };

  // Derive redaction set from the actual serialized request (not pre-serialization).
  const artifacts = [...(authResult.sensitiveArtifacts ?? [])];
  const sigMatch = headers['Authorization']?.match(/Signature=([0-9a-fA-F]{64})/);
  if (sigMatch) artifacts.push(sigMatch[1]); // HMAC Signature sub-component
  if (authResult.queryParams) {
    const qIdx = finalUrl.indexOf('?');
    if (qIdx !== -1) {
      const names = new Set(Object.keys(authResult.queryParams));
      const qs = finalUrl.slice(qIdx + 1).split('#')[0];
      for (const pair of qs.split('&')) {
        const eq = pair.indexOf('=');
        if (eq !== -1 && names.has(pair.slice(0, eq)) && pair.length - eq > 4) {
          artifacts.push(pair.slice(eq + 1));
        }
      }
    }
  }
  const secrets = buildSecretsList(credentials, artifacts);

  const REQUEST_TIMEOUT_MS = 30_000;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal?.throwIfAborted();
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            r();
          },
          { once: true },
        );
      });
      signal?.throwIfAborted();
    }

    // Compose caller cancellation with per-request timeout so that
    // providing a signal does not silently drop the 30 s guard.
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(finalUrl, {
        method: endpoint.method,
        headers,
        body: endpoint.method !== 'GET' ? body : undefined,
        signal: requestSignal,
      });
    } catch (err) {
      // Abort/timeout errors are terminal — do not retry.
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (err instanceof DOMException && err.name === 'TimeoutError') throw err;
      // Network failures (TypeError: fetch failed, etc.) are retryable.
      // Scrub credentials from the exception message — providers may echo
      // secrets in transport-layer errors.
      const rawMsg = err instanceof Error ? err.message : String(err);
      lastError = new Error(scrubSecrets(rawMsg, secrets));
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const scrubbed = scrubSecrets(text.slice(0, 500), secrets);
      lastError = new Error(`HTTP ${resp.status}: ${scrubbed}`);
      // Retry transient errors; permanent 4xx (except 429) are terminal.
      if (TRANSIENT_STATUS_CODES.has(resp.status) && attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    return { json: await resp.json(), secrets };
  }

  throw lastError ?? new Error('Request failed after retries');
}

function mapStatus(rawStatus: string | undefined, statusMap: Record<string, string[]>): TaskStatus {
  if (!rawStatus) return 'running';
  const lower = rawStatus.toLowerCase();
  for (const [mapped, patterns] of Object.entries(statusMap)) {
    if (patterns.some((p) => p.toLowerCase() === lower)) return mapped as TaskStatus;
  }
  return 'running';
}

function checkBusinessCode(json: unknown, endpoint: Endpoint, secrets: string[]): void {
  const resp = endpoint.response;
  if (resp.codeField && resp.successCode !== undefined) {
    const code = extractString(json, resp.codeField);
    if (code !== undefined && Number(code) !== resp.successCode) {
      const errMsg = resp.error ? extractString(json, resp.error) : undefined;
      // Deep-scrub the JSON object before stringifying — defeats JSON escaping.
      const raw = errMsg ? scrubSecrets(errMsg, secrets) : JSON.stringify(scrubJsonValue(json, secrets));
      const scrubbedCode = scrubSecrets(String(code), secrets);
      throw new Error(`Business error code=${scrubbedCode}: ${raw}`);
    }
  }
}

// ── Public API ──

export async function submit(
  template: ProtocolTemplate,
  params: ExecutionParams,
  signal?: AbortSignal,
): Promise<SubmitResult> {
  if (template.mode !== 'async') throw new Error(`submit() requires async mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  if (!cap.submit) throw new Error(`Capability "${params.capability}" has no submit endpoint`);

  const vars = { ...params.vars, model: params.vars['model'] ?? params.provider.model ?? '' };
  const { json, secrets } = await executeRequest(
    cap.submit,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
    signal,
  );

  checkBusinessCode(json, cap.submit, secrets);

  const taskId = extractString(json, cap.submit.response.taskId ?? '$.id');
  if (!taskId) {
    throw new Error(`No taskId in response: ${JSON.stringify(scrubJsonValue(json, secrets))}`);
  }

  const rawStatus = cap.submit.response.status ? extractString(json, cap.submit.response.status) : undefined;
  const statusMap = cap.submit.response.statusMap ?? {};
  const status = rawStatus ? mapStatus(rawStatus, statusMap) : 'queued';

  return { taskId: scrubSecrets(taskId, secrets), status };
}

export async function poll(
  template: ProtocolTemplate,
  params: ExecutionParams,
  taskId: string,
  signal?: AbortSignal,
): Promise<PollResult> {
  if (template.mode !== 'async') throw new Error(`poll() requires async mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  const pollDef = resolvePoll(template, cap, params.capability);

  const vars = { ...params.vars, taskId, model: params.vars['model'] ?? params.provider.model ?? '' };
  const { json, secrets } = await executeRequest(
    pollDef,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
    signal,
  );

  checkBusinessCode(json, pollDef, secrets);

  const resp = pollDef.response;
  const rawStatus = resp.status ? extractString(json, resp.status) : undefined;
  const status = mapStatus(rawStatus, resp.statusMap ?? {});

  let resultUrl = resp.resultUrl ? extractString(json, resp.resultUrl) : undefined;
  if (!resultUrl && resp.fallbackResultUrl) {
    const fallback = extractString(json, resp.fallbackResultUrl);
    if (fallback) {
      try {
        const parsed = JSON.parse(fallback);
        resultUrl = typeof parsed === 'string' ? parsed : (parsed?.url ?? parsed?.video_url);
      } catch {
        resultUrl = fallback;
      }
    }
  }

  const coverUrl = resp.coverUrl ? extractString(json, resp.coverUrl) : undefined;
  const error = resp.error ? extractString(json, resp.error) : undefined;

  return {
    status,
    resultUrl: resultUrl ? scrubSecrets(resultUrl, secrets) : undefined,
    coverUrl: coverUrl ? scrubSecrets(coverUrl, secrets) : undefined,
    error: error ? scrubSecrets(error, secrets) : undefined,
  };
}

export async function execute(
  template: ProtocolTemplate,
  params: ExecutionParams,
  signal?: AbortSignal,
): Promise<SyncResult> {
  if (template.mode !== 'sync') throw new Error(`execute() requires sync mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  if (!cap.request) throw new Error(`Capability "${params.capability}" has no request endpoint`);

  const vars = { ...params.vars, model: params.vars['model'] ?? params.provider.model ?? '' };
  const { json, secrets } = await executeRequest(
    cap.request,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
    signal,
  );

  checkBusinessCode(json, cap.request, secrets);

  const result = extractString(json, cap.request.response.result ?? '$.result');
  if (!result) {
    throw new Error(`No result in response: ${JSON.stringify(scrubJsonValue(json, secrets))}`);
  }

  return { result: scrubSecrets(result, secrets) };
}

function resolvePoll(template: ProtocolTemplate, cap: Capability, capName: string): PollEndpoint {
  if (cap.poll) return cap.poll as PollEndpoint;
  if (cap.inherit) {
    const ref = cap.inherit.split('.');
    const parentCap = template.capabilities[ref[0]];
    if (parentCap?.poll) return parentCap.poll as PollEndpoint;
  }
  throw new Error(`Capability "${capName}" has no poll endpoint and no inherit reference`);
}
