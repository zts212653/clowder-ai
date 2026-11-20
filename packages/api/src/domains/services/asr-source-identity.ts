import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isLoopbackAddress } from '../../utils/loopback-request.js';
import { resolveServiceScriptPath } from './service-lifecycle.js';

// Also read at process startup by whisper-api.py. The fingerprint only covers
// code the ASR sidecar owns, so an unrelated API commit can reuse it.
const ASR_SOURCES = ['dedicated_model_worker.py', 'qwen_asr_backend.py', 'whisper-api.py'];

export async function readWhisperSourceDigest(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ASR_SOURCES) {
    const bytes = await readFile(resolveServiceScriptPath(`scripts/services/${name}`));
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

export function isManagedWhisperEndpoint(endpoint: string | null, port?: number): boolean {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'http:' && Number(url.port || 80) === port && (host === 'localhost' || isLoopbackAddress(host))
    );
  } catch {
    return false;
  }
}
