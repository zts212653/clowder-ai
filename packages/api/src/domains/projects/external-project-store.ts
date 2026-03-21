/**
 * F076: ExternalProjectStore — in-memory store for external projects
 */

import { resolve } from 'node:path';
import type { CreateExternalProjectInput, ExternalProject } from '@cat-cafe/shared';
import { generateSortableId } from '../cats/services/stores/ports/MessageStore.js';

export class ExternalProjectStore {
  private readonly projects = new Map<string, ExternalProject>();

  create(userId: string, input: CreateExternalProjectInput): ExternalProject {
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
    this.projects.set(project.id, project);
    return project;
  }

  listByUser(userId: string): ExternalProject[] {
    return [...this.projects.values()].filter((p) => p.userId === userId).sort((a, b) => b.id.localeCompare(a.id));
  }

  getById(id: string): ExternalProject | null {
    return this.projects.get(id) ?? null;
  }

  update(id: string, patch: Partial<CreateExternalProjectInput>): ExternalProject | null {
    const existing = this.projects.get(id);
    if (!existing) return null;
    const updated: ExternalProject = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sourcePath !== undefined ? { sourcePath: patch.sourcePath } : {}),
      ...(patch.backlogPath !== undefined ? { backlogPath: patch.backlogPath } : {}),
      updatedAt: Date.now(),
    };
    this.projects.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.projects.delete(id);
  }
}
