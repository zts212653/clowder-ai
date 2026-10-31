import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type PluginArchiveReplacementConfirmation,
  PluginArchiveReplacementConfirmationSchema,
} from '@cat-cafe/shared';
import type { MultipartValue } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { PluginManagerService } from '../domains/plugin/manager/plugin-manager-service.js';

function parseReplacementField(part: MultipartValue): PluginArchiveReplacementConfirmation {
  if (part.valueTruncated || typeof part.value !== 'string') {
    throw new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid replacement confirmation');
  }
  const parsed = PluginArchiveReplacementConfirmationSchema.safeParse(JSON.parse(part.value));
  if (!parsed.success) throw new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid replacement confirmation');
  return parsed.data;
}

export class PluginManagerUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'AUDIT_UNAVAILABLE' | 'INVALID_UPLOAD' | 'NO_FILE' | 'PACKAGE_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'PluginManagerUploadError';
  }
}

function translateUploadReadError(error: unknown): PluginManagerUploadError {
  if (error instanceof PluginManagerUploadError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PluginManagerUploadError(413, 'PACKAGE_TOO_LARGE', 'Plugin package exceeds the Host size limit');
  }
  return new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid upload');
}

export async function readPluginUpload(
  request: FastifyRequest,
): Promise<{ bytes: Buffer; replacement?: PluginArchiveReplacementConfirmation }> {
  let bytes: Buffer | undefined;
  let replacement: PluginArchiveReplacementConfirmation | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'replacement' && replacement === undefined) {
        replacement = parseReplacementField(part);
        continue;
      }
      if (part.type !== 'file' || part.fieldname !== 'file' || bytes !== undefined) {
        if (part.type === 'file') await part.toBuffer();
        throw new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid upload');
      }
      bytes = await part.toBuffer();
    }
  } catch (error) {
    throw translateUploadReadError(error);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new PluginManagerUploadError(400, 'NO_FILE', 'No plugin archive uploaded');
  }
  return { bytes, ...(replacement ? { replacement } : {}) };
}

export async function installPluginUpload(
  upload: { bytes: Buffer; replacement?: PluginArchiveReplacementConfirmation },
  manager: Pick<PluginManagerService, 'install'>,
  auditBeforeInstall: () => Promise<void>,
): Promise<unknown> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-plugin-upload-'));
  const archivePath = join(temporaryRoot, 'package.tgz');
  try {
    await writeFile(archivePath, upload.bytes, { flag: 'wx', mode: 0o600 });
    try {
      await auditBeforeInstall();
    } catch {
      throw new PluginManagerUploadError(503, 'AUDIT_UNAVAILABLE', 'Plugin audit log is unavailable');
    }
    return await manager.install({
      source: { kind: 'local-archive', path: archivePath },
      ...(upload.replacement ? { replacement: upload.replacement } : {}),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
