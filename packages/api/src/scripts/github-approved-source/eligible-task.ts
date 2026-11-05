import type { SourceScope } from './approved-scope.js';
import type { SourceModules } from './archive.js';

export interface Reader {
  read(command: string, ...args: string[]): Promise<unknown>;
}
export interface PureSourceHelpers {
  legacyRepositories(
    reader: Reader,
    scope: SourceScope,
    signal: AbortSignal,
  ): Promise<{
    repositories: readonly unknown[];
    claims: unknown;
    unresolved: number;
  }>;
  pendingReceipt(reader: Reader, scope: SourceScope, task: unknown): Promise<unknown>;
  values: {
    hash(reader: Reader, key: string, fields: readonly string[]): Promise<Record<string, string>>;
    number(value: unknown): number;
    identifier(value: string): string;
    json(value: string): unknown;
    record(value: unknown): Record<string, unknown>;
    ownedThread(reader: Reader, scope: SourceScope, threadId: string): Promise<boolean>;
    taskFields: readonly string[];
  };
}

function isNeeded(state: Record<string, string>, values: PureSourceHelpers['values']) {
  if (!['todo', 'doing', 'blocked', 'done'].includes(state.status ?? '')) throw new Error('Unknown tracking status');
  const automation = state.automationState ? values.record(values.json(state.automationState)) : {};
  const outcome = automation.waitOutcome ? values.record(automation.waitOutcome) : undefined;
  const issue = automation.issue ? values.record(automation.issue) : undefined;
  return state.status !== 'done' || outcome?.delivery === 'pending' || !!issue?.pendingWake;
}

async function readEligibility(
  reader: Reader,
  scope: SourceScope,
  id: string,
  kind: string,
  helpers: PureSourceHelpers,
) {
  const { hash, ownedThread } = helpers.values;
  const key = `${scope.keyPrefix}task:${id}`;
  const identity = await hash(reader, key, ['id', 'kind', 'userId', 'threadId', 'subjectKey']);
  if (identity.id !== id || identity.kind !== kind || !identity.threadId) throw new Error('Corrupt GitHub task index');
  if (identity.userId && identity.userId !== scope.ownerUserId) return { identity };
  const subject = /^(pr|issue):([^#]+)#[1-9]\d*$/.exec(identity.subjectKey ?? '');
  if (!subject || typeof subject[2] !== 'string') throw new Error('Unattributed GitHub subject');
  if (!scope.repositories.includes(subject[2])) return { identity };
  // No persisted owner: provenance must be known before reading eligibility.
  if (!identity.userId && !(await ownedThread(reader, scope, identity.threadId)))
    throw new Error('Legacy GitHub source ownership unavailable');
  const state = await hash(reader, key, ['status', 'automationState']);
  return { identity, state };
}

async function requiredTask(
  reader: Reader,
  scope: SourceScope,
  identity: Record<string, string>,
  state: Record<string, string>,
  helpers: PureSourceHelpers,
) {
  const { hash, number, json, ownedThread, taskFields } = helpers.values;
  const threadId = identity.threadId;
  if (!threadId || !(await ownedThread(reader, scope, threadId)))
    throw new Error('Required GitHub destination ownership unavailable');
  const key = `${scope.keyPrefix}task:${identity.id}`;
  for (const field of ['pluginWait', 'entrustedWork'])
    if (number(await reader.read('HEXISTS', key, field))) throw new Error('Unsupported active Host obligation');
  const raw = await hash(reader, key, taskFields);
  for (const field of ['id', 'kind', 'userId', 'threadId', 'subjectKey'])
    if (raw[field] !== identity[field]) throw new Error('Task binding changed during source read');
  if (raw.status !== state.status || raw.automationState !== state.automationState)
    throw new Error('Task eligibility changed during source read');
  const task = {
    ...raw,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
    ...(raw.automationState ? { automationState: json(raw.automationState) } : {}),
  };
  const receipt = await helpers.pendingReceipt(reader, scope, task);
  const refs: string[] = [];
  for (const field of ['typedWaitRegistration', 'invocationLease', 'claimHistory']) {
    const present = number(await reader.read('HEXISTS', key, field));
    refs.push(`legacy:${identity.id}:${field}:${present ? 'present' : 'absent'}`);
  }
  return { task, receipt, refs };
}

export async function readEligibleTask(
  reader: Reader,
  scope: SourceScope,
  id: string,
  kind: string,
  helpers: PureSourceHelpers,
  digest: SourceModules['sourceDigest'],
) {
  if (scope.excludedTaskIds.includes(id)) throw new Error('Excluded Task appears in GitHub index');
  const { identity, state } = await readEligibility(reader, scope, id, kind, helpers);
  const census = state ? { identity, eligibilityDigest: digest(state) } : identity;
  if (!state || !isNeeded(state, helpers.values)) return { census };
  return { census, ...(await requiredTask(reader, scope, identity, state, helpers)) };
}
