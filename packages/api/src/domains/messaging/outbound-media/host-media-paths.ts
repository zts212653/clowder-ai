/**
 * F202 W2-5b — Host route URL → local file path, for media the Host itself serves.
 *
 * Extracted with its rules unchanged from the legacy connector gateway, so the outbound media
 * materializer and the legacy outbound hook share one whitelist until W2-4 deletes the legacy
 * path. Four route prefixes map onto four roots; anything else, any traversal out of a root, and
 * any path that does not exist resolves to nothing.
 *
 * The result is a candidate, not a trusted file: the media ledger opens it with O_NOFOLLOW and
 * requires a regular file before copying, which covers what an existence check alone does not
 * (symlinks, directories).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultUploadDir } from '../../../utils/upload-paths.js';
import { resolveTtsCacheDir } from '../../cats/services/tts/document-listen-paths.js';

export interface HostMediaPathRoots {
  readonly uploadDir: string;
  readonly ttsCacheDir: string;
  readonly connectorMediaDir: string;
  readonly webPublicDir: string;
}

export type HostMediaPathResolver = (url: string) => string | undefined;

/** The roots the running Host serves these prefixes from; same derivation as the legacy gateway. */
export function hostMediaPathRootsFromEnv(env: NodeJS.ProcessEnv, connectorMediaDir: string): HostMediaPathRoots {
  return {
    uploadDir: getDefaultUploadDir(env.UPLOAD_DIR),
    ttsCacheDir: resolve(resolveTtsCacheDir()),
    connectorMediaDir: resolve(connectorMediaDir),
    webPublicDir: resolve(env.WEB_PUBLIC_DIR ?? '../web/public'),
  };
}

export function createHostMediaPathResolver(roots: HostMediaPathRoots): HostMediaPathResolver {
  // Phase J P1: guard against path traversal (e.g. /uploads/../../etc/passwd)
  const safeResolve = (base: string, suffix: string): string | undefined => {
    const resolved = resolve(base, suffix);
    if (!(resolved.startsWith(`${base}/`) || resolved === base)) return undefined;
    return existsSync(resolved) ? resolved : undefined;
  };
  return (url: string): string | undefined => {
    if (url.startsWith('/uploads/')) return safeResolve(roots.uploadDir, url.slice('/uploads/'.length));
    if (url.startsWith('/api/tts/audio/')) return safeResolve(roots.ttsCacheDir, url.slice('/api/tts/audio/'.length));
    if (url.startsWith('/api/connector-media/')) {
      return safeResolve(roots.connectorMediaDir, url.slice('/api/connector-media/'.length));
    }
    if (url.startsWith('/avatars/')) return safeResolve(roots.webPublicDir, url.slice(1));
    return undefined;
  };
}
