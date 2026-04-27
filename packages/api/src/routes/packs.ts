/**
 * F129 Pack Routes
 * POST /api/packs/add    — Install a pack from local directory path (Phase A: local only)
 * GET  /api/packs         — List installed packs
 * DELETE /api/packs/:name — Remove a pack
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { checkGrowthBoundary } from '../domains/packs/GrowthBoundary.js';
import { PackExporter } from '../domains/packs/PackExporter.js';
import type { PackLoader } from '../domains/packs/PackLoader.js';

const addSchema = z.object({
  source: z.string().min(1),
});

const exportSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  catConfig: z.record(z.unknown()).optional(),
  sharedRulesContent: z.string().optional(),
  skillsManifestContent: z.string().optional(),
});

export interface PacksRoutesOptions {
  packLoader: PackLoader;
  catTemplatePath?: string;
  sharedRulesPath?: string;
  skillsManifestPath?: string;
}

export const packsRoutes: FastifyPluginAsync<PacksRoutesOptions> = async (app, opts) => {
  const { packLoader } = opts;

  app.post('/api/packs/add', async (request, reply) => {
    const parseResult = addSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    try {
      const manifest = await packLoader.add(parseResult.data.source);
      reply.status(201);
      return { ok: true, manifest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSecurityError = msg.includes('security') || msg.includes('Security');
      reply.status(isSecurityError ? 403 : 400);
      return { ok: false, error: msg };
    }
  });

  app.get('/api/packs', async () => {
    const packs = await packLoader.list();
    return { packs };
  });

  app.delete('/api/packs/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!name || typeof name !== 'string') {
      reply.status(400);
      return { error: 'Pack name required' };
    }

    const removed = await packLoader.remove(name);
    return { removed };
  });

  app.post('/api/packs/export', async (request, reply) => {
    const parseResult = exportSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const {
      name,
      catConfig: bodyCatConfig,
      sharedRulesContent: bodyRules,
      skillsManifestContent: bodySkills,
    } = parseResult.data;

    // Resolve catConfig: body → cat-template file path → error
    let catConfig = bodyCatConfig;
    if (!catConfig && opts.catTemplatePath) {
      try {
        catConfig = JSON.parse(await readFile(opts.catTemplatePath, 'utf-8'));
      } catch {
        /* file unreadable — fall through to error */
      }
    }

    // Resolve sharedRulesContent
    let sharedRulesContent = bodyRules;
    if (!sharedRulesContent && opts.sharedRulesPath) {
      try {
        sharedRulesContent = await readFile(opts.sharedRulesPath, 'utf-8');
      } catch {
        /* fall through */
      }
    }

    // Resolve skillsManifestContent
    let skillsManifestContent = bodySkills;
    if (!skillsManifestContent && opts.skillsManifestPath) {
      try {
        skillsManifestContent = await readFile(opts.skillsManifestPath, 'utf-8');
      } catch {
        /* fall through */
      }
    }

    if (!catConfig || !sharedRulesContent || !skillsManifestContent) {
      reply.status(400);
      return { error: 'Missing required data: catConfig, sharedRulesContent, skillsManifestContent' };
    }

    // Validate catConfig shape before passing to exporter
    const cc = catConfig as Record<string, unknown>;
    if (!cc.roster || typeof cc.roster !== 'object' || !Array.isArray(cc.breeds)) {
      reply.status(400);
      return { error: 'catConfig must have roster (object) and breeds (array)' };
    }

    try {
      const exporter = new PackExporter();
      const outputDir = await mkdtemp(join(tmpdir(), 'pack-export-'));
      const result = await exporter.exportPack({
        catConfig: catConfig as unknown as Parameters<PackExporter['exportPack']>[0]['catConfig'],
        sharedRulesContent,
        skillsManifestContent,
        outputDir,
        packName: name ?? 'exported-pack',
      });
      // Growth boundary check on exported pack (KD-11)
      const growthCheck = await checkGrowthBoundary(outputDir);
      if (!growthCheck.clean) {
        reply.status(400);
        return { ok: false, error: 'Exported pack contains Growth data', violations: growthCheck.violations };
      }

      return { ok: true, manifest: result.manifest, warnings: result.warnings, outputDir: result.outputDir };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // TypeError = malformed catConfig structure → client error, not server error
      const status = err instanceof TypeError ? 400 : 500;
      reply.status(status);
      return { ok: false, error: msg };
    }
  });
};
