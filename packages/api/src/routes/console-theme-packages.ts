import { readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  assetMimes,
  exportCustomTheme,
  exportPackage,
  installPackage,
  listPackages,
  packagesRoot,
  readPackage,
  themeId,
} from '../domains/console-themes/packages.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export async function consoleThemePackageRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) return reply.code(401).send({ error: 'Owner identity required' });
    const denied = resolveOwnerGate(userId);
    if (denied) return reply.code(denied.status).send({ error: 'Owner identity required' });
  });
  app.addHook('preValidation', async (request, reply) => {
    const params = request.params as { id?: string; file?: string };
    if (params.id !== undefined && !themeId.test(params.id)) return reply.code(400).send({ error: 'Invalid theme id' });
    if (params.file !== undefined && !/^[^/\\\0]+\.(png|jpg|jpeg|webp|gif|svg|woff2|woff|ttf)$/.test(params.file)) {
      return reply.code(400).send({ error: 'Invalid asset file' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return reply.code(404).send({ error: 'Theme or asset not found' });
    return reply.send(error);
  });
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const url = '/api/console-themes/packages';

  app.post(url, { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'Expected a zip body' });
    try {
      return await installPackage(opts.projectRoot, request.body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
  app.get(url, async () => ({ packages: await listPackages(opts.projectRoot) }));
  app.get<{ Params: { id: string } }>(`${url}/:id`, async (request) =>
    readPackage(opts.projectRoot, request.params.id),
  );
  app.get<{ Params: { id: string; file: string } }>(`${url}/:id/assets/:file`, async (request, reply) => {
    const { id, file } = request.params;
    return reply
      .type(assetMimes[extname(file)])
      .send(await readFile(join(packagesRoot(opts.projectRoot), id, 'assets', file)));
  });
  app.delete<{ Params: { id: string } }>(`${url}/:id`, async (request, reply) => {
    await rm(join(packagesRoot(opts.projectRoot), request.params.id), { recursive: true });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>(`${url}/:id/export`, async (request, reply) => {
    const { id } = request.params;
    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${id}.theme.zip"`)
      .send(await exportPackage(opts.projectRoot, id));
  });
  app.post<{ Body: { theme?: unknown } }>(
    '/api/console-themes/export',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const { id, zip } = exportCustomTheme(request.body?.theme);
        return reply
          .type('application/zip')
          .header('content-disposition', `attachment; filename="${id}.theme.zip"`)
          .send(zip);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );
}
