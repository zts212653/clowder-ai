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

async function executeRequest(
  endpoint: Endpoint,
  baseUrl: string,
  authType: AuthType,
  credentials: Record<string, string>,
  vars: Record<string, string>,
): Promise<unknown> {
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

  const REQUEST_TIMEOUT_MS = 30_000;
  const resp = await fetch(finalUrl, {
    method: endpoint.method,
    headers,
    body: endpoint.method !== 'GET' ? body : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

function mapStatus(rawStatus: string | undefined, statusMap: Record<string, string[]>): TaskStatus {
  if (!rawStatus) return 'running';
  const lower = rawStatus.toLowerCase();
  for (const [mapped, patterns] of Object.entries(statusMap)) {
    if (patterns.some((p) => p.toLowerCase() === lower)) return mapped as TaskStatus;
  }
  return 'running';
}

function checkBusinessCode(json: unknown, endpoint: Endpoint): void {
  const resp = endpoint.response;
  if (resp.codeField && resp.successCode !== undefined) {
    const code = extractString(json, resp.codeField);
    if (code !== undefined && Number(code) !== resp.successCode) {
      const errMsg = resp.error ? extractString(json, resp.error) : undefined;
      throw new Error(`Business error code=${code}: ${errMsg ?? JSON.stringify(json)}`);
    }
  }
}

// ── Public API ──

export async function submit(template: ProtocolTemplate, params: ExecutionParams): Promise<SubmitResult> {
  if (template.mode !== 'async') throw new Error(`submit() requires async mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  if (!cap.submit) throw new Error(`Capability "${params.capability}" has no submit endpoint`);

  const vars = { ...params.vars, model: params.vars['model'] ?? params.provider.model ?? '' };
  const json = await executeRequest(
    cap.submit,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
  );

  checkBusinessCode(json, cap.submit);

  const taskId = extractString(json, cap.submit.response.taskId ?? '$.id');
  if (!taskId) throw new Error(`No taskId in response: ${JSON.stringify(json)}`);

  const rawStatus = cap.submit.response.status ? extractString(json, cap.submit.response.status) : undefined;
  const statusMap = cap.submit.response.statusMap ?? {};
  const status = rawStatus ? mapStatus(rawStatus, statusMap) : 'queued';

  return { taskId, status, raw: json };
}

export async function poll(template: ProtocolTemplate, params: ExecutionParams, taskId: string): Promise<PollResult> {
  if (template.mode !== 'async') throw new Error(`poll() requires async mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  const pollDef = resolvePoll(template, cap, params.capability);

  const vars = { ...params.vars, taskId, model: params.vars['model'] ?? params.provider.model ?? '' };
  const json = await executeRequest(
    pollDef,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
  );

  checkBusinessCode(json, pollDef);

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

  return { status, resultUrl, coverUrl, error, raw: json };
}

export async function execute(template: ProtocolTemplate, params: ExecutionParams): Promise<SyncResult> {
  if (template.mode !== 'sync') throw new Error(`execute() requires sync mode, got ${template.mode}`);

  const cap = resolveCapability(template, params.capability);
  if (!cap.request) throw new Error(`Capability "${params.capability}" has no request endpoint`);

  const vars = { ...params.vars, model: params.vars['model'] ?? params.provider.model ?? '' };
  const json = await executeRequest(
    cap.request,
    params.provider.baseUrl,
    params.provider.authType,
    params.credentials,
    vars,
  );

  checkBusinessCode(json, cap.request);

  const result = extractString(json, cap.request.response.result ?? '$.result');
  if (!result) throw new Error(`No result in response: ${JSON.stringify(json)}`);

  return { result, raw: json };
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
