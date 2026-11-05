import type { TaskItem } from '@cat-cafe/shared';
import type { TypedWaitRegistration } from '../../../../../ball-custody/TypedWaitRegistration.js';
import { isDeploymentWaitProjectionCandidate } from './live-candidate.js';
import {
  type DeploymentRecoveryFacts,
  type DeploymentWaitAudit,
  nextDeploymentAuditAt,
  reconcileDeploymentRecoveryFacts,
} from './recovery-facts.js';

export { isDeploymentWaitProjectionCandidate } from './live-candidate.js';

/** Original Task-owned recovery facts. Every memory writer already publishes through this Map. */
export class DeploymentWaitTaskMap extends Map<string, TaskItem> {
  private readonly live = new Set<string>();
  private readonly audit = new Set<string>();
  private readonly facts = new Map<string, DeploymentRecoveryFacts>();
  constructor(private readonly receipt: (id: string) => TypedWaitRegistration | null) {
    super();
  }
  override set(id: string, task: TaskItem): this {
    this.facts.set(id, reconcileDeploymentRecoveryFacts(this.get(id), task, this.receipt(id), this.facts.get(id)));
    super.set(id, task);
    this.project(id);
    return this;
  }
  override delete(id: string): boolean {
    this.live.delete(id);
    this.audit.delete(id);
    this.facts.delete(id);
    return super.delete(id);
  }
  override clear(): void {
    this.live.clear();
    this.audit.clear();
    this.facts.clear();
    super.clear();
  }
  candidates(): TaskItem[] {
    return [...this.live].flatMap((id) => {
      const task = this.get(id);
      return task ? [task] : [];
    });
  }
  due(limit = 100, now = Date.now()): TaskItem[] {
    const tasks: TaskItem[] = [];
    for (const id of this.live) {
      const task = this.get(id),
        live = this.facts.get(id)?.live;
      if (task && live && !live.disposition && live.nextAt <= now && isDeploymentWaitProjectionCandidate(task))
        tasks.push(task);
      if (tasks.length >= limit) break;
    }
    return tasks;
  }
  audits(limit = 100, now = Date.now()): DeploymentWaitAudit[] {
    const entries: DeploymentWaitAudit[] = [];
    for (const id of this.audit) {
      const facts = this.facts.get(id);
      for (const entry of Object.values(facts?.pending ?? {})) {
        if (!entry.disposition && entry.nextAt <= now) entries.push(structuredClone(entry));
        if (entries.length >= limit) return entries;
      }
    }
    return entries;
  }
  ack(entry: DeploymentWaitAudit): boolean {
    const facts = this.facts.get(entry.taskId),
      current = facts?.pending[entry.event.eventId];
    if (!facts || !current || current.token !== entry.token) return false;
    delete facts.pending[entry.event.eventId];
    this.project(entry.taskId);
    return true;
  }
  failAudit(entry: DeploymentWaitAudit, now: number): void {
    const current = this.facts.get(entry.taskId)?.pending[entry.event.eventId];
    if (!current || JSON.stringify(current) !== JSON.stringify(entry)) return;
    current.failures++;
    current.nextAt = now + 60_000;
    if (current.failures >= 5) current.disposition = 'needs_attention';
    this.project(entry.taskId);
  }
  finishLive(task: TaskItem, now: number, failed: boolean): void {
    const live = this.facts.get(task.id)?.live;
    if (!live || live.signature !== JSON.stringify(task.deploymentWait)) return;
    live.nextAt = now;
    if (failed) {
      if (++live.failures >= 5) live.disposition = 'needs_attention';
    } else live.failures = 0;
    this.project(task.id);
  }
  hasRecoveryResponsibility(id: string): boolean {
    const facts = this.facts.get(id);
    return Boolean(facts?.live || Object.keys(facts?.pending ?? {}).length);
  }
  recoveryFacts(id: string): DeploymentRecoveryFacts | null {
    return structuredClone(this.facts.get(id) ?? null);
  }
  private project(id: string): void {
    const facts = this.facts.get(id);
    if (facts?.live) this.live.add(id);
    else this.live.delete(id);
    if (facts && nextDeploymentAuditAt(facts) !== undefined) this.audit.add(id);
    else this.audit.delete(id);
  }
}
