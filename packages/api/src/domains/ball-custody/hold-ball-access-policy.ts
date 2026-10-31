import type { CallbackPrincipal } from '@cat-cafe/shared';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { DEFAULT_THREAD_ID } from '../cats/services/stores/ports/ThreadStore.js';

export type HoldAccessRole = 'trigger_principal' | 'thread_collaborator' | 'operator';
export type HoldAuthKind = 'invocation' | 'agent_key' | 'operator';

export interface HoldOwnerIdentity {
  readonly catId: string;
  readonly userId: string | null;
}

export interface HoldAccessActor {
  readonly kind: 'cat' | 'operator';
  readonly id: string;
  readonly userId: string;
  readonly authKind: HoldAuthKind;
  readonly role: HoldAccessRole;
}

export interface HoldAccessDecision {
  readonly owner: HoldOwnerIdentity;
  readonly actor: HoldAccessActor;
  readonly lifecycleVisibility: 'full' | 'summary';
}

interface HoldAccessThread {
  readonly id: string;
  readonly participants: readonly string[];
}

export interface ResolveHoldAccessInput {
  readonly task: DynamicTaskDef;
  readonly thread: HoldAccessThread;
  readonly callbackPrincipal?: CallbackPrincipal;
  readonly operatorUserId?: string | null;
  readonly configuredOwnerUserId: string;
  readonly principalCanAccessThread: boolean;
  readonly operatorCanAccessThread: boolean;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readHoldOwner(task: DynamicTaskDef): HoldOwnerIdentity {
  const createdBy = nonEmptyString(task.createdBy);
  const catId = createdBy?.startsWith('hold-ball:') ? createdBy.slice('hold-ball:'.length) : 'unknown';
  return {
    catId: catId || 'unknown',
    userId: nonEmptyString(task.params.triggerUserId),
  };
}

function isTriggerPrincipal(principal: CallbackPrincipal, owner: HoldOwnerIdentity): boolean {
  return owner.userId !== null && principal.catId === owner.catId && principal.userId === owner.userId;
}

function passesDefaultThreadUserFence(
  thread: HoldAccessThread,
  principal: CallbackPrincipal,
  owner: HoldOwnerIdentity,
): boolean {
  if (thread.id !== DEFAULT_THREAD_ID) return true;
  return owner.userId !== null && principal.userId === owner.userId;
}

/**
 * Resolve hold authority from verified identities only.
 *
 * Callback identity always wins over operator identity so a cat cannot borrow a
 * simultaneous browser/session principal. Invocation credentials are already
 * exact-thread capabilities; persistent agent keys additionally need canonical
 * thread visibility plus owner/participant standing.
 */
export function resolveHoldAccess(input: ResolveHoldAccessInput): HoldAccessDecision | null {
  const owner = readHoldOwner(input.task);
  const principal = input.callbackPrincipal;
  if (principal) {
    if (!input.principalCanAccessThread) return null;
    if (!passesDefaultThreadUserFence(input.thread, principal, owner)) return null;
    if (
      principal.kind === 'agent_key' &&
      principal.catId !== owner.catId &&
      !input.thread.participants.includes(principal.catId)
    ) {
      return null;
    }
    const role: HoldAccessRole = isTriggerPrincipal(principal, owner) ? 'trigger_principal' : 'thread_collaborator';
    return {
      owner,
      actor: {
        kind: 'cat',
        id: principal.catId,
        userId: principal.userId,
        authKind: principal.kind,
        role,
      },
      lifecycleVisibility: role === 'trigger_principal' ? 'full' : 'summary',
    };
  }

  const operatorUserId = input.operatorUserId?.trim();
  if (!operatorUserId || operatorUserId !== input.configuredOwnerUserId || !input.operatorCanAccessThread) {
    return null;
  }
  return {
    owner,
    actor: {
      kind: 'operator',
      id: operatorUserId,
      userId: operatorUserId,
      authKind: 'operator',
      role: 'operator',
    },
    lifecycleVisibility: 'full',
  };
}

export function projectHoldOwner(
  owner: HoldOwnerIdentity,
  lifecycleVisibility: HoldAccessDecision['lifecycleVisibility'],
): { catId: string; userId?: string } {
  return {
    catId: owner.catId,
    ...(lifecycleVisibility === 'full' && owner.userId ? { userId: owner.userId } : {}),
  };
}
