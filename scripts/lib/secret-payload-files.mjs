import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { scanSecretContent } from './secret-content-scan.mjs';
import { isCredentialSource } from './secret-credential-paths.mjs';
export const SECRET_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;

export function assertSecretFree(content) {
  if (scanSecretPayload(content).length) throw new Error('secret_content_detected');
}

export function scanSecretPayload(content) {
  const bytes = Buffer.from(content);
  if (bytes.length > SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_payload_size_limit');
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const start = Math.max(0, offset - 20000);
    const first = scanSecretContent(bytes.subarray(start, offset + 1024 * 1024))[0];
    if (first) {
      const absolute = start + first.offset;
      const prefix = bytes.subarray(0, absolute).toString('latin1');
      return [
        { ...first, offset: absolute, line: prefix.split('\n').length, column: absolute - prefix.lastIndexOf('\n') },
      ];
    }
  }
  return [];
}

/** Read an already opened regular file once; the executor only receives this copy. */
export function readSecretPayload(path, cwd, credentialSources) {
  if (isCredentialSource(path, cwd, credentialSources)) throw new Error('credential_source_blocked_before_read');
  let fd;
  try {
    fd = openSync(resolve(cwd ?? process.cwd(), path), 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_payload_uninspectable');
    const bytes = Buffer.alloc(before.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('secret_payload_changed');
    }
    const content = bytes.subarray(0, length);
    assertSecretFree(content);
    return content;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createPayloadSnapshot() {
  let dir;
  let count = 0;
  let total = 0;
  return {
    freeze(content, filename = 'payload') {
      total += Buffer.byteLength(content);
      if (count >= 64 || total > 2 * SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_payload_batch_limit');
      assertSecretFree(content);
      dir ??= mkdtempSync(join(tmpdir(), 'cat-cafe-send-'));
      const folder = join(dir, `${++count}`);
      mkdirSync(folder, { mode: 0o700 });
      const path = join(folder, basename(filename));
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
      return path;
    },
    dispose() {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
