import type { ProducerAttentionReevaluationLinkV1 } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../../../domains/cats/services/owner-auth-provenance.js';
import type { DisplayCategory, SubjectKind, TaskSpec_P1, TriggerSpec } from '../types.js';

/** Parameters for creating a dynamic task instance from a template */
export interface DynamicTaskParams {
  trigger: TriggerSpec;
  params: Record<string, unknown>;
  entrustedWorkReevaluation?: ProducerAttentionReevaluationLinkV1;
  deliveryThreadId: string | null;
  /** Server-private authority fact for a durable hold continuation; never part of params or public projections. */
  ownerAuthProvenance?: OwnerAuthProvenance;
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
