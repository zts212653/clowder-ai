import {
  ACTION_SUBJECT_REF_DESCRIPTION,
  ACTION_SUBJECT_REF_MAX_LENGTH,
  ACTION_SUBJECT_REF_PATTERN,
  ACTION_SUCCESSOR_ACTION_FAMILIES,
  type ActionSuccessorActionFamily,
  type ActionSuccessorSlot,
  isAllowedActionSuccessorSlot,
} from '@cat-cafe/shared';

const ACTION_FAMILIES = new Set<string>(ACTION_SUCCESSOR_ACTION_FAMILIES);

export type ActionSuccessorIdentityErrorCode =
  | 'invalid_tenant_scope'
  | 'invalid_subject_ref'
  | 'invalid_action_family'
  | 'invalid_successor_slot';

export class ActionSuccessorIdentityError extends Error {
  constructor(
    readonly code: ActionSuccessorIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionSuccessorIdentityError';
  }
}

export interface ActionSuccessorIdentityInput {
  tenantScope: string;
  subjectRef: string;
  actionFamily: string;
  successorSlot: string;
}

export interface ActionSuccessorIdentity {
  tenantScope: string;
  subjectRef: string;
  actionFamily: ActionSuccessorActionFamily;
  successorSlot: ActionSuccessorSlot;
  key: string;
}

export function canonicalizeActionSubjectRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ACTION_SUBJECT_REF_MAX_LENGTH || !ACTION_SUBJECT_REF_PATTERN.test(trimmed)) {
    throw new ActionSuccessorIdentityError(
      'invalid_subject_ref',
      `invalid action subjectRef: ${value}. ${ACTION_SUBJECT_REF_DESCRIPTION}`,
    );
  }
  const pr = /^pr:([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/i.exec(trimmed);
  if (pr) {
    const [, owner, repo, number] = pr;
    if (owner && repo && number) return `pr:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  }
  const opaque = /^subject:([a-z][a-z0-9_-]{0,63}):(\S{1,200})$/i.exec(trimmed);
  if (opaque) {
    const [, namespace, id] = opaque;
    if (namespace && id && !id.includes('\u001f')) return `subject:${namespace.toLowerCase()}:${id}`;
  }
  throw new ActionSuccessorIdentityError(
    'invalid_subject_ref',
    `invalid action subjectRef: ${value}. ${ACTION_SUBJECT_REF_DESCRIPTION}`,
  );
}

export function canonicalizeActionIdentity(input: ActionSuccessorIdentityInput): ActionSuccessorIdentity {
  const tenantScope = input.tenantScope.trim();
  if (!tenantScope || tenantScope.includes('\u001f')) {
    throw new ActionSuccessorIdentityError('invalid_tenant_scope', 'tenantScope must be non-empty');
  }
  if (!ACTION_FAMILIES.has(input.actionFamily)) {
    throw new ActionSuccessorIdentityError('invalid_action_family', `invalid action family: ${input.actionFamily}`);
  }
  const actionFamily = input.actionFamily as ActionSuccessorActionFamily;
  if (!isAllowedActionSuccessorSlot(actionFamily, input.successorSlot)) {
    throw new ActionSuccessorIdentityError(
      'invalid_successor_slot',
      `successor slot ${input.successorSlot} is not allowed for ${actionFamily}`,
    );
  }
  const successorSlot = input.successorSlot as ActionSuccessorSlot;
  const subjectRef = canonicalizeActionSubjectRef(input.subjectRef);
  return {
    tenantScope,
    subjectRef,
    actionFamily,
    successorSlot,
    key: [tenantScope, subjectRef, actionFamily, successorSlot].join('\u001f'),
  };
}
