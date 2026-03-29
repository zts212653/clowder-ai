import type { DisplayCategory, SubjectKind, TaskDisplayMeta, TaskSpec_P1, TriggerSpec } from '../types.js';

/** Parameters for creating a dynamic task instance from a template */
export interface DynamicTaskParams {
  trigger: TriggerSpec;
  params: Record<string, unknown>;
  deliveryThreadId: string | null;
}

/** Template definition — code-defined, provides gate/execute factories */
export interface TaskTemplate {
  templateId: string;
  label: string;
  category: DisplayCategory;
  description: string;
  subjectKind: SubjectKind;
  defaultTrigger: TriggerSpec;
  paramSchema: Record<string, { type: 'string' | 'number'; required: boolean; description: string }>;
  createSpec: (instanceId: string, params: DynamicTaskParams) => TaskSpec_P1;
}
