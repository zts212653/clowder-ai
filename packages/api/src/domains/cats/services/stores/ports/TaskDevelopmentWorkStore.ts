import type { DevelopmentScopeV1, TaskItem } from '@cat-cafe/shared';
import {
  type DevelopmentSourceQuery,
  type DevelopmentWorkReceipt,
  type DevelopmentWorkResult,
  type DevelopmentWorkTransition,
  developmentActionKey,
  developmentScopeKey,
  developmentWorkIsOpen,
  hasDevelopmentSourceReceipt,
  matchesDevelopmentScope,
  prepareDevelopmentWorkTransition,
} from './DevelopmentWorkTransition.js';

export class TaskDevelopmentWorkStore {
  private readonly openScopes = new Map<string, string>();
  private readonly receipts = new Map<string, DevelopmentWorkReceipt>();
  constructor(
    private readonly tasks: Map<string, TaskItem>,
    private readonly subjects: Map<string, string>,
    private readonly ensureCapacity: () => void,
  ) {}

  find(userId: string, scope: DevelopmentScopeV1): TaskItem[] {
    const matches = [...this.tasks.values()].filter((task) => matchesDevelopmentScope(task, userId, scope));
    const open = matches.find(developmentWorkIsOpen);
    const key = developmentScopeKey(userId, scope);
    if (open) this.openScopes.set(key, open.id);
    else this.openScopes.delete(key);
    return matches;
  }

  hasSource(query: DevelopmentSourceQuery): boolean {
    return hasDevelopmentSourceReceipt(this.tasks.get(query.taskId) ?? null, this.receipts.values(), query);
  }

  transition(input: DevelopmentWorkTransition): DevelopmentWorkResult {
    const scoped = this.find(input.actor.userId, input.scope);
    const receiptKey = developmentActionKey(input);
    const receipt = this.receipts.get(receiptKey) ?? null;
    const existing = input.taskId ? (this.tasks.get(input.taskId) ?? null) : null;
    const lineage = [input.parentTaskRef, input.predecessorTaskRef].flatMap((ref) => {
      const task = ref ? this.tasks.get(ref.slice('task:work:'.length)) : null;
      return task ? [task] : [];
    });
    const prepared = prepareDevelopmentWorkTransition(input, scoped, existing, receipt, lineage);
    if (prepared.result !== 'write') return prepared;
    const subject = prepared.task.subjectKey;
    if (!subject) throw new Error('Prepared development Task requires a subject');
    const owner = this.subjects.get(subject);
    if (owner && owner !== prepared.task.id) return { result: 'scope_conflict' };
    if (!existing) this.ensureCapacity();
    this.tasks.set(prepared.task.id, prepared.task);
    this.subjects.set(subject, prepared.task.id);
    this.openScopes.set(developmentScopeKey(input.actor.userId, input.scope), prepared.task.id);
    this.receipts.set(receiptKey, prepared.receipt);
    return { result: prepared.receipt.result, task: prepared.task, receiptRef: prepared.receipt.receiptRef };
  }

  closed(task: TaskItem): void {
    if (task.userId && task.entrustedWork?.developmentScope) {
      this.openScopes.delete(developmentScopeKey(task.userId, task.entrustedWork.developmentScope));
    }
  }
}
