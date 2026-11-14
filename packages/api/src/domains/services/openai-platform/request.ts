import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultUploadDir } from '../../../utils/upload-paths.js';
import { EventAuditLog } from '../../cats/services/orchestration/EventAuditLog.js';
import { platformHttpTransport } from './http-transport.js';
import { assertNoRequestCredential } from './input-files.js';
import { resolvePlatformTarget } from './platform-target.js';
import { buildPlatformRequestBody } from './request-body.js';
import { type PlatformRequestReceipt, parsePlatformRequest, platformPathModel } from './request-contract.js';
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

/** Server-side full HTTP requests. No model list or provider parameter rewriting. No paid retries. */
export async function executePlatformRequest(
  options: PlatformRequestOptions,
  value: unknown,
): Promise<PlatformRequestReceipt> {
  const input = parsePlatformRequest(value);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(input.timeoutMs)]);
  const send = options.fetch ?? platformHttpTransport.fetch;
  const target = await resolvePlatformTarget(options.projectRoot, input, { fetch: send, signal });
  const { provider } = target;
  const credentials = [...new Set(target.credentials)];
  assertNoRequestCredential(target.url + input.accountRef, credentials);
  const built = buildPlatformRequestBody(input, {
    projectRoot: options.projectRoot,
    fileRoot: options.fileRoot,
    credentials,
  });
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
    provider,
    method: input.request.method,
    path: input.request.path,
    model: platformPathModel(provider, input.request.path) ?? built.model,
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
    data: {
      callId,
      accountRef: receipt.accountRef,
      provider,
      method: receipt.method,
      path: receipt.path,
      model: receipt.model,
    },
  });
  const began = Date.now();
  const responsePath = join(directory, 'response.bin');
  try {
    signal.throwIfAborted();
    // Revalidate the actual URL and add host-owned authentication, immediately before the only send.
    target.authenticate(built.headers);
    options.onSend?.({ callId, receiptFile: receipt.receiptFile });
    const response = await abortable(
      signal,
      send(target.url, {
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
