import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredCredentialValues } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { resolveOpenAIPlatformAccount } from '../../../config/account-resolver.js';
import { assertPlatformAccountDestination, platformAccountBaseUrl } from '../../../config/platform-authentication.js';
import { getDefaultUploadDir } from '../../../utils/upload-paths.js';
import { EventAuditLog } from '../../cats/services/orchestration/EventAuditLog.js';
import { platformHttpTransport } from './http-transport.js';
import { assertNoRequestCredential } from './input-files.js';
import { buildPlatformRequestBody } from './request-body.js';
import { type PlatformRequestReceipt, parsePlatformRequest } from './request-contract.js';
import { abortable, readPlatformUsage, savePlatformResponse } from './response-file.js';

export interface PlatformRequestOptions {
  projectRoot: string;
  fileRoot: string;
  outputDir?: string;
  auditLog?: Pick<EventAuditLog, 'append'>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onSend?: (ref: Pick<PlatformRequestReceipt, 'callId' | 'receiptFile'>) => void;
}

function accountForRequest(projectRoot: string, accountRef: string) {
  try {
    const profile = resolveOpenAIPlatformAccount(projectRoot, accountRef);
    if (!profile?.apiKey?.trim() || /[\r\n\s]/u.test(profile.apiKey)) throw new Error('unavailable');
    return { ...profile, apiKey: profile.apiKey };
  } catch {
    throw Object.assign(
      new Error('Selected OpenAI Platform API key account is unavailable; check the Hub account configuration'),
      {
        code: 'platform_account_unavailable',
      },
    );
  }
}

/** Server-side full HTTP requests. No model list or provider parameter rewriting. No paid retries. */
export async function executeOpenAIPlatformRequest(
  options: PlatformRequestOptions,
  value: unknown,
): Promise<PlatformRequestReceipt> {
  const input = parsePlatformRequest(value);
  const profile = accountForRequest(options.projectRoot, input.accountRef);
  const credentials = [...new Set([profile.apiKey, ...configuredCredentialValues()])];
  const base = platformAccountBaseUrl(profile, 'openai');
  const url = new URL(base.href);
  const requested = new URL(input.request.path, 'https://api.openai.com');
  url.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + requested.pathname;
  url.search = requested.search;
  assertPlatformAccountDestination(profile, 'openai', url.href);
  assertNoRequestCredential(url.href + input.accountRef, credentials);
  const built = buildPlatformRequestBody(input, {
    projectRoot: options.projectRoot,
    fileRoot: options.fileRoot,
    credentials,
  });
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(input.timeoutMs)]);
  signal.throwIfAborted();
  const callId = randomUUID();
  const directory = join(
    options.outputDir ?? join(getDefaultUploadDir(process.env.UPLOAD_DIR), 'platform-calls'),
    callId,
  );
  assertNoRequestCredential(directory, credentials);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const audit = options.auditLog ?? new EventAuditLog();
  const receipt: PlatformRequestReceipt = {
    callId,
    accountRef: input.accountRef,
    provider: 'openai',
    method: input.request.method,
    path: input.request.path,
    model: built.model,
    status: 'unconfirmed',
    startedAt,
    durationMs: 0,
    timeoutMs: input.timeoutMs,
    httpStatus: null,
    requestId: null,
    contentType: null,
    responseHeaders: null,
    responseFile: null,
    responseBytes: 0,
    responseSha256: null,
    receiptFile: join(directory, 'receipt.json'),
    usage: null,
    cost: null,
    error: null,
  };
  // Admission is durable before spending. This log never stores prompts, headers or credentials.
  await audit.append({
    type: 'platform.request.started',
    data: { callId, accountRef: receipt.accountRef, method: receipt.method, path: receipt.path, model: receipt.model },
  });
  const began = Date.now();
  const responsePath = join(directory, 'response.bin');
  try {
    signal.throwIfAborted();
    // Revalidate the actual URL, immediately before the only send.
    assertPlatformAccountDestination(profile, 'openai', url.href);
    built.headers.set('authorization', `Bearer ${profile.apiKey}`);
    options.onSend?.({ callId, receiptFile: receipt.receiptFile });
    const response = await abortable(
      signal,
      (options.fetch ?? platformHttpTransport.fetch)(url.href, {
        method: input.request.method,
        redirect: 'error',
        signal,
        headers: built.headers,
        body: built.body,
      }),
    );
    receipt.httpStatus = response.status;
    const requestId = response.headers.get('x-request-id');
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie'));
    assertNoRequestCredential(JSON.stringify(responseHeaders), credentials);
    receipt.responseHeaders = responseHeaders;
    receipt.requestId = requestId?.slice(0, 160) ?? null;
    receipt.contentType = contentType.slice(0, 200);
    const saved = await savePlatformResponse(response, responsePath, {
      signal,
      maxBytes: input.maxResponseBytes,
      credentials,
    });
    receipt.responseFile = responsePath;
    receipt.responseBytes = saved.bytes;
    receipt.responseSha256 = saved.sha256;
    receipt.usage = await readPlatformUsage(responsePath, receipt.contentType);
    receipt.status = response.ok ? 'completed' : 'http_error';
  } catch {
    await rm(responsePath, { force: true });
    receipt.responseFile = null;
    receipt.requestId = credentials.some((key) => receipt.requestId?.includes(key)) ? null : receipt.requestId;
    receipt.contentType = credentials.some((key) => receipt.contentType?.includes(key)) ? null : receipt.contentType;
    receipt.error = 'Request outcome unconfirmed; do not automatically repeat a potentially charged request';
  }
  receipt.durationMs = Date.now() - began;
  const temporary = `${receipt.receiptFile}.partial`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, receipt.receiptFile);
  await audit.append({ type: 'platform.request.finished', data: { ...receipt } });
  return receipt;
}
