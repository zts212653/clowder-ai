import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isDirectLoopbackRequest, isTrustedLocalApiRequest } from '../utils/loopback-request.js';

const exec = promisify(execFile);
export type AuthorizedMediaFile = {
  path: string;
  mime: string;
  byteLength: number;
  author?: string;
  createdAt?: string;
};
type Dependencies = {
  allowDirectoryReveal?: boolean;
  authorize: (request: FastifyRequest) => Promise<AuthorizedMediaFile | { local: false } | null>;
  onError: (reply: FastifyReply, error: unknown) => unknown;
};
const defaultAppScript = `ObjC.import('AppKit');
function run(argv) {
 const type = $.NSClassFromString('UTType').typeWithMIMEType(argv[0]);
 const url = type ? $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenContentType(type) : null;
 return url ? JSON.stringify({path: ObjC.unwrap(url.path), name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path)), bundleId: ObjC.unwrap($.NSBundle.bundleWithURL(url).bundleIdentifier)}) : '{}';
}`;
async function defaultApp(mime: string): Promise<{ path?: string; name?: string; bundleId?: string }> {
  if (process.platform !== 'darwin') return {};
  try {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', defaultAppScript, mime], { timeout: 5000 });
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object') return {};
    const app = value as { path?: unknown; name?: unknown; bundleId?: unknown };
    return typeof app.path === 'string' && app.path.endsWith('.app') && typeof app.name === 'string'
      ? {
          path: app.path,
          name: app.name.replace(/\.app$/, ''),
          bundleId: typeof app.bundleId === 'string' ? app.bundleId : undefined,
        }
      : {};
  } catch {
    return {};
  }
}
export function isLocalHumanFileActionRequest(request: FastifyRequest) {
  return (
    isDirectLoopbackRequest(request) &&
    isTrustedLocalApiRequest(request) &&
    !request.callbackPrincipal &&
    !request.headers['x-invocation-id'] &&
    !request.headers['x-callback-token'] &&
    !request.headers['x-agent-key-secret']
  );
}

/** A file action is always re-authorized by the same media owner, never by a caller-supplied path. */
export function registerMediaFileActions(app: FastifyInstance, mediaPath: string, deps: Dependencies) {
  app.get(`${mediaPath}/file-info`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!isLocalHumanFileActionRequest(request)) return { local: false };
    try {
      const file = await deps.authorize(request);
      if (!file) return reply.code(401).send({ error: 'identity_required' });
      if ('local' in file) return { local: false };
      const info = await stat(file.path);
      if (!info.isFile()) return reply.code(404).send({ error: 'not_found' });
      const application = await defaultApp(file.mime);
      const home = homedir();
      return {
        ...file,
        local: true,
        filename: basename(file.path),
        displayPath: file.path.startsWith(`${home}/`) ? `~${file.path.slice(home.length)}` : file.path,
        modifiedAt: info.mtime.toISOString(),
        defaultApplication: application.name ?? null,
        defaultApplicationBundleId: application.bundleId,
      };
    } catch (error) {
      return deps.onError(reply, error);
    }
  });
  for (const action of ['reveal', 'open'] as const) {
    app.post(`${mediaPath}/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!isLocalHumanFileActionRequest(request)) return reply.code(403).send({ error: 'local_human_required' });
      if (request.body && Object.keys(request.body as object).length)
        return reply.code(400).send({ error: 'unexpected_action_input' });
      try {
        const file = await deps.authorize(request);
        if (!file) return reply.code(401).send({ error: 'identity_required' });
        if ('local' in file) return reply.code(403).send({ error: 'local_file_unavailable' });
        const info = await stat(file.path);
        if (!info.isFile() && !(deps.allowDirectoryReveal && action === 'reveal' && info.isDirectory()))
          return reply.code(404).send({ error: 'not_found' });
        if (process.platform !== 'darwin') return reply.code(422).send({ error: 'desktop_action_unavailable' });
        if (action === 'reveal') {
          await exec('open', ['-R', file.path], { timeout: 5000 });
        } else {
          const application = await defaultApp(file.mime);
          if (!application.path) return reply.code(422).send({ error: 'default_application_unavailable' });
          await exec('open', ['-a', application.path, file.path], { timeout: 5000 });
        }
        return { ok: true };
      } catch (error) {
        return deps.onError(reply, error);
      }
    });
  }
}
