/**
 * F076: External Project routes — CRUD + BACKLOG import
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalProject } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { NeedAuditFrameStore } from '../domains/projects/need-audit-frame-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { buildBacklogInputFromFeature, getFeatureTagId, parseActiveFeaturesFromBacklog } from './backlog-doc-import.js';

export interface ExternalProjectRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  needAuditFrameStore: NeedAuditFrameStore;
  backlogStore: IBacklogStore;
}

export const externalProjectRoutes: FastifyPluginAsync<ExternalProjectRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, needAuditFrameStore, backlogStore } = opts;

  /** Returns userId or sends 401 and returns null */
  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  /** Resolves project with ownership check. Returns project or sends 404 and returns null. */
  function requireOwnedProject(id: string, userId: string, reply: FastifyReply): ExternalProject | null {
    const project = externalProjectStore.getById(id);
    if (!project || project.userId !== userId) {
      void reply.status(404).send({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  // --- External Project CRUD ---

  app.post('/api/external-projects', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const body = request.body as {
      name?: string;
      description?: string;
      sourcePath?: string;
      backlogPath?: string;
    };
    if (!body.name || !body.sourcePath) {
      return reply.status(400).send({ error: 'name and sourcePath are required' });
    }
    try {
      const project = externalProjectStore.create(userId, {
        name: body.name,
        description: body.description ?? '',
        sourcePath: body.sourcePath,
        ...(body.backlogPath ? { backlogPath: body.backlogPath } : {}),
      });
      return reply.status(201).send({ project });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  app.get('/api/external-projects', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const projects = externalProjectStore.listByUser(userId);
    return reply.send({ projects });
  });

  app.get('/api/external-projects/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = requireOwnedProject(id, userId, reply);
    if (!project) return;
    return reply.send({ project });
  });

  app.delete('/api/external-projects/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = requireOwnedProject(id, userId, reply);
    if (!project) return;
    externalProjectStore.delete(id);
    return reply.status(204).send();
  });

  // --- BACKLOG import ---

  app.post('/api/external-projects/:id/import-backlog', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = requireOwnedProject(id, userId, reply);
    if (!project) return;

    const backlogFullPath = join(project.sourcePath, project.backlogPath);
    let markdown: string;
    try {
      markdown = await readFile(backlogFullPath, 'utf-8');
    } catch {
      return reply.status(400).send({ error: `Cannot read ${backlogFullPath}` });
    }

    const rows = parseActiveFeaturesFromBacklog(markdown);
    const existingItems = await backlogStore.listByUser(userId);
    const existingFeatureIds = new Set(
      existingItems
        .filter((item) => item.projectId === project.id)
        .map((item) => getFeatureTagId(item.tags))
        .filter(Boolean),
    );

    let created = 0;
    let skipped = 0;
    for (const row of rows) {
      const featureId = row.id.toLowerCase();
      if (existingFeatureIds.has(featureId)) {
        skipped++;
        continue;
      }
      const input = buildBacklogInputFromFeature(row, userId);
      await backlogStore.create({ ...input, projectId: project.id });
      created++;
    }

    return reply.send({ imported: created, skipped, total: rows.length });
  });

  // --- Need Audit Frame routes ---

  app.post('/api/external-projects/:projectId/frame', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const body = request.body as Record<string, unknown>;
    try {
      const frame = needAuditFrameStore.upsert(projectId, {
        sponsor: (body.sponsor as string) ?? '',
        motivation: (body.motivation as string) ?? '',
        successMetric: (body.successMetric as string) ?? '',
        constraints: (body.constraints as string) ?? '',
        currentWorkflow: (body.currentWorkflow as string) ?? '',
        provenanceMap: (body.provenanceMap as string) ?? '',
      });
      return reply.send({ frame });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  app.get('/api/external-projects/:projectId/frame', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    const frame = needAuditFrameStore.getByProject(projectId);
    if (!frame) return reply.status(404).send({ error: 'Audit frame not found' });
    return reply.send({ frame });
  });
};
