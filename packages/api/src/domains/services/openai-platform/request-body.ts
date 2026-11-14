import { basename } from 'node:path';
import { assertNoRequestCredential, createPlatformInputReader, type PlatformInputOptions } from './input-files.js';
import type { PlatformRequest } from './request-contract.js';

type InputReader = ReturnType<typeof createPlatformInputReader>;
type Request = PlatformRequest['request'];

function requestHeaders(request: Request, credentials: readonly string[]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (
      /^(?:authorization|host|content-length|content-type|transfer-encoding|connection|cookie|proxy-.*|x-api-key|x-goog-api-key|x-goog-user-project)$/i.test(
        name,
      )
    )
      throw new Error('Platform authentication and transport headers belong to the host');
    assertNoRequestCredential(`${name}: ${value}`, credentials);
    headers.set(name, value);
  }
  return headers;
}

function appendFields(form: FormData, request: Request, reader: InputReader): void {
  for (const [name, items] of Object.entries(request.fields ?? {})) {
    reader.accept(name);
    for (const value of Array.isArray(items) ? items : [items]) {
      if (typeof value === 'object')
        form.append(
          name,
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(reader.read(value.fromFile)),
        );
      else {
        const text = String(value);
        reader.accept(text);
        form.append(name, text);
      }
    }
  }
}

function appendFiles(form: FormData, request: Request, reader: InputReader): void {
  for (const [name, items] of Object.entries(request.files ?? {})) {
    for (const value of Array.isArray(items) ? items : [items]) {
      const filename = value.filename ?? basename(value.path);
      const contentType = value.contentType ?? 'application/octet-stream';
      reader.accept(name + filename + contentType);
      form.append(name, new Blob([new Uint8Array(reader.read(value.path))], { type: contentType }), filename);
    }
  }
}

function jsonModel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('model' in value)) return null;
  return typeof value.model === 'string' ? value.model : null;
}

/** Serialize only the transport envelope; all provider parameters and model names stay caller-owned. */
export function buildPlatformRequestBody(
  input: PlatformRequest,
  options: PlatformInputOptions,
): {
  body?: string | FormData;
  headers: Headers;
  model: string | null;
} {
  const request = input.request;
  const headers = requestHeaders(request, options.credentials);
  const reader = createPlatformInputReader(options);
  const contentType = request.contentType?.toLowerCase();
  if (contentType === 'multipart/form-data') {
    if (request.body !== undefined) throw new Error('Multipart uses fields and files, not a JSON body');
    const form = new FormData();
    appendFields(form, request, reader);
    appendFiles(form, request, reader);
    const model = form.get('model');
    return { headers, body: form, model: typeof model === 'string' ? model : null };
  }
  if (request.fields || request.files) throw new Error('Files and fields require multipart/form-data');
  if (request.body === undefined) return { headers, model: null };
  if (contentType && contentType !== 'application/json') throw new Error('Use application/json or multipart/form-data');
  const body = JSON.stringify(request.body);
  reader.accept(body);
  headers.set('content-type', 'application/json');
  return { headers, body, model: jsonModel(request.body) };
}
