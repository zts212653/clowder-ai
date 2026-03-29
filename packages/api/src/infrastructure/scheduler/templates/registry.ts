import { reminderTemplate } from './reminder.js';
import { repoActivityTemplate } from './repo-activity.js';
import type { TaskTemplate } from './types.js';
import { webDigestTemplate } from './web-digest.js';

/** Centralized registry of available task templates (Phase 3A AC-G5) */
class TemplateRegistry {
  private templates = new Map<string, TaskTemplate>();

  register(template: TaskTemplate): void {
    this.templates.set(template.templateId, template);
  }

  unregister(templateId: string): boolean {
    return this.templates.delete(templateId);
  }

  get(templateId: string): TaskTemplate | null {
    return this.templates.get(templateId) ?? null;
  }

  list(): TaskTemplate[] {
    return [...this.templates.values()];
  }
}

export const templateRegistry = new TemplateRegistry();
templateRegistry.register(reminderTemplate);
templateRegistry.register(webDigestTemplate);
templateRegistry.register(repoActivityTemplate);

export type { DynamicTaskParams, TaskTemplate } from './types.js';
