/**
 * F076: ExternalProjectStore — Redis-backed store for external projects
 * Falls back to in-memory Map when Redis is not available.
 */

import { resolve } from 'node:path';
import type { CreateExternalProjectInput, ExternalProject } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../cats/services/stores/ports/MessageStore.js';
import { ExternalProjectKeys } from '../cats/services/stores/redis-keys/external-project-keys.js';

export class ExternalProjectStore {
  private readonly redis: RedisClient | undefined;
  private readonly fallbackProjects = new Map<string, ExternalProject>();

  constructor(redis?: RedisClient) {
    this.redis = redis;
  }

  async create(userId: string, input: CreateExternalProjectInput): Promise<ExternalProject> {
    if (!input.sourcePath) {
      throw new Error('sourcePath is required');
    }
    // P2-1: Prevent path traversal — resolved backlogPath must stay within sourcePath
    const backlogPath = input.backlogPath ?? 'docs/ROADMAP.md';
    const resolvedBacklog = resolve(input.sourcePath, backlogPath);
    const resolvedSource = resolve(input.sourcePath);
    if (!resolvedBacklog.startsWith(`${resolvedSource}/`) && resolvedBacklog !== resolvedSource) {
      throw new Error('backlogPath must not escape sourcePath');
    }
    const now = Date.now();
    const project: ExternalProject = {
      id: `ep-${generateSortableId(now)}`,
      userId,
      name: input.name,
      description: input.description,
      sourcePath: input.sourcePath,
      backlogPath,
      createdAt: now,
      updatedAt: now,
    };
    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.hset(ExternalProjectKeys.detail(project.id), this.serializeProject(project));
      pipeline.zadd(ExternalProjectKeys.userList(userId), String(now), project.id);
      await pipeline.exec();
    } else {
      this.fallbackProjects.set(project.id, project);
    }
    return project;
  }

  async listByUser(userId: string): Promise<ExternalProject[]> {
    if (this.redis) {
      const ids = await this.redis.zrevrange(ExternalProjectKeys.userList(userId), 0, -1);
      if (ids.length === 0) return [];

      const pipeline = this.redis.multi();
      for (const id of ids) {
        pipeline.hgetall(ExternalProjectKeys.detail(id));
      }
      const rows = await pipeline.exec();
      if (!rows) return [];

      const result: ExternalProject[] = [];
      for (const [err, data] of rows) {
        if (err || !data || typeof data !== 'object') continue;
        const row = data as Record<string, string>;
        if (!row.id) continue;
        result.push(this.hydrateProject(row));
      }
      return result;
    }
    return [...this.fallbackProjects.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  async getById(id: string): Promise<ExternalProject | null> {
    if (this.redis) {
      const data = await this.redis.hgetall(ExternalProjectKeys.detail(id));
      if (!data || !data.id) return null;
      return this.hydrateProject(data as Record<string, string>);
    }
    return this.fallbackProjects.get(id) ?? null;
  }

  async update(id: string, patch: Partial<CreateExternalProjectInput>): Promise<ExternalProject | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const updated: ExternalProject = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sourcePath !== undefined ? { sourcePath: patch.sourcePath } : {}),
      ...(patch.backlogPath !== undefined ? { backlogPath: patch.backlogPath } : {}),
      updatedAt: Date.now(),
    };
    if (this.redis) {
      await this.redis.hset(ExternalProjectKeys.detail(id), this.serializeProject(updated));
    } else {
      this.fallbackProjects.set(id, updated);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const project = await this.getById(id);
    if (!project) return false;
    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.del(ExternalProjectKeys.detail(id));
      pipeline.zrem(ExternalProjectKeys.userList(project.userId), id);
      await pipeline.exec();
    } else {
      this.fallbackProjects.delete(id);
    }
    return true;
  }

  private serializeProject(project: ExternalProject): Record<string, string> {
    return {
      id: project.id,
      userId: project.userId,
      name: project.name,
      description: project.description,
      sourcePath: project.sourcePath,
      backlogPath: project.backlogPath,
      createdAt: String(project.createdAt),
      updatedAt: String(project.updatedAt),
    };
  }

  private hydrateProject(data: Record<string, string>): ExternalProject {
    return {
      id: data.id ?? '',
      userId: data.userId ?? '',
      name: data.name ?? '',
      description: data.description ?? '',
      sourcePath: data.sourcePath ?? '',
      backlogPath: data.backlogPath ?? 'docs/ROADMAP.md',
      createdAt: Number.parseInt(data.createdAt ?? '0', 10),
      updatedAt: Number.parseInt(data.updatedAt ?? '0', 10),
    };
  }
}
