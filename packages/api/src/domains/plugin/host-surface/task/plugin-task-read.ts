import { collectiveOwnerAdmissionV1Schema, type PluginWaitState, type TaskItem } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import { snapshotPluginProtocolData } from '../../carrier/plugin-protocol-data.js';

type Work = NonNullable<TaskItem['entrustedWork']>;
type DataController = NonNullable<Work['dataController']>;

/** Read-only package data. This summary conveys no admission or execution authority. */
export type PluginTaskReadItem = Pick<
  TaskItem,
  | 'id'
  | 'kind'
  | 'threadId'
  | 'subjectKey'
  | 'title'
  | 'ownerCatId'
  | 'status'
  | 'why'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
> & {
  readonly userId: string | null;
  readonly pluginWait?: Pick<PluginWaitState, 'pluginInstanceId' | 'generation' | 'await' | 'waitOutcome'>;
  readonly entrustedWork?: {
    readonly revision: Work['revision'];
    readonly time?: Work['time'];
    readonly artifactRefs: readonly string[];
    readonly closure: Pick<Work['closure'], 'state'>;
    readonly admission: {
      readonly sourceRefs: readonly string[];
      readonly authorityRef?: string;
      /** Host-verified historical receipt coordinate. It is a read fact, never an execution grant. */
      readonly hostReceipt?: { readonly receiptRef: string; readonly sourceRef: string; readonly catId: string };
    };
    readonly dataController?: {
      readonly bindingRevision: number;
      readonly state: 'active' | 'revoked';
      /** Host-derived live fence; never persisted and never supplied by the package. */
      readonly currentForCaller: boolean;
      readonly binding: DataController['binding'] & {
        /**
         * Deprecated read-only compatibility epoch for SDK 0.2 Task readers.
         * It conveys no current grant or mutation authority.
         */
        readonly grantRevision: number;
      };
      readonly revocationReceiptRef?: string;
    };
  };
};

function legacyGrantRevision(controller: DataController): number {
  const bindingReceipt = controller.receipts?.find(
    (receipt) => receipt.kind === 'bind' && receipt.receiptRef === controller.binding.ownerOperationReceiptRef,
  );
  // Contract 0.3 removed mutable grant authority. Older SDK 0.2 readers still
  // require this positive read field, so preserve the immutable historical
  // value when one exists and expose a stable compatibility epoch otherwise.
  return bindingReceipt?.kind === 'bind' ? (bindingReceipt.controller.grantRevision ?? 1) : 1;
}

function projectWait(wait: PluginWaitState): NonNullable<PluginTaskReadItem['pluginWait']> {
  return {
    pluginInstanceId: wait.pluginInstanceId,
    generation: wait.generation,
    ...(wait.await === undefined
      ? {}
      : {
          await: {
            generation: wait.await.generation,
            ...(wait.await.expiresAt === undefined ? {} : { expiresAt: wait.await.expiresAt }),
          },
        }),
    ...(wait.waitOutcome === undefined
      ? {}
      : {
          waitOutcome: {
            outcomeId: wait.waitOutcome.outcomeId,
            generation: wait.waitOutcome.generation,
            ownerFence: { kind: wait.waitOutcome.ownerFence.kind, generation: wait.waitOutcome.ownerFence.generation },
            reason: wait.waitOutcome.reason,
            delivery: wait.waitOutcome.delivery,
          },
        }),
  };
}

export function projectPluginTaskRead(
  task: TaskItem,
  dataControllerCurrentForCaller = false,
  hostReceipt?: NonNullable<PluginTaskReadItem['entrustedWork']>['admission']['hostReceipt'],
): PluginTaskReadItem {
  const work = task.entrustedWork;
  return snapshotPluginProtocolData({
    id: task.id,
    kind: task.kind,
    threadId: task.threadId,
    subjectKey: task.subjectKey,
    title: task.title,
    ownerCatId: task.ownerCatId,
    status: task.status,
    why: task.why,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    userId: task.userId ?? null,
    ...(task.pluginWait === undefined ? {} : { pluginWait: projectWait(task.pluginWait) }),
    ...(work === undefined
      ? {}
      : {
          entrustedWork: {
            revision: work.revision,
            artifactRefs: work.artifactRefs,
            ...(work.time === undefined ? {} : { time: work.time }),
            closure: { state: work.closure.state },
            admission: {
              sourceRefs: work.admission.sourceRefs,
              ...('authorityRef' in work.admission ? { authorityRef: work.admission.authorityRef } : {}),
              ...(hostReceipt === undefined ? {} : { hostReceipt }),
            },
            ...(work.dataController === undefined
              ? {}
              : {
                  dataController: {
                    bindingRevision: work.dataController.bindingRevision,
                    state: work.dataController.state,
                    currentForCaller: dataControllerCurrentForCaller,
                    binding: {
                      ...work.dataController.binding,
                      grantRevision: legacyGrantRevision(work.dataController),
                    },
                    ...(work.dataController.revocationReceiptRef === undefined
                      ? {}
                      : { revocationReceiptRef: work.dataController.revocationReceiptRef }),
                  },
                }),
          },
        }),
  }) as PluginTaskReadItem;
}

export async function projectOwnedPluginTasks(
  tasks: readonly TaskItem[],
  ownerUserId: string,
  threads: Pick<IThreadStore, 'get'> | undefined,
  controllerCurrency: ReadonlyMap<string, boolean> = new Map(),
  messages?: Pick<IMessageStore, 'getById'>,
): Promise<readonly PluginTaskReadItem[]> {
  const visible: PluginTaskReadItem[] = [];
  for (const task of tasks) {
    if (task.userId != null) {
      if (task.userId !== ownerUserId) continue;
    } else {
      // Legacy ownership is established by the actual thread, never the caller.
      const thread = await threads?.get(task.threadId);
      if (!thread || thread.id !== task.threadId || thread.createdBy !== ownerUserId || thread.deletedAt) continue;
    }
    visible.push(
      projectPluginTaskRead(
        task,
        controllerCurrency.get(task.id) ?? false,
        await readVerifiedHostReceipt(task, ownerUserId, messages),
      ),
    );
  }
  return Object.freeze(visible);
}

export async function readVerifiedHostReceipt(
  task: TaskItem,
  ownerUserId: string,
  messages: Pick<IMessageStore, 'getById'> | undefined,
): Promise<NonNullable<PluginTaskReadItem['entrustedWork']>['admission']['hostReceipt'] | undefined> {
  const work = task.entrustedWork;
  const sourceRef = work?.admission.sourceRefs[0];
  const receiptRef = work && 'authorityRef' in work.admission ? work.admission.authorityRef : undefined;
  if (
    !messages ||
    !work ||
    task.kind !== 'work' ||
    task.userId !== ownerUserId ||
    !task.ownerCatId ||
    work.admission.basis !== 'authorized_source' ||
    work.admission.sourceRefs.length !== 1 ||
    typeof sourceRef !== 'string' ||
    typeof receiptRef !== 'string' ||
    !sourceRef.startsWith('message:') ||
    !receiptRef.startsWith('message:') ||
    sourceRef === receiptRef
  ) {
    return undefined;
  }
  const receiptId = receiptRef.slice('message:'.length);
  const message = structuredClone(await messages.getById(receiptId));
  const extra = message?.extra as Record<string, unknown> | undefined;
  const receipt = collectiveOwnerAdmissionV1Schema.safeParse(extra?.collectiveOwnerAdmissionV1);
  if (
    !message ||
    !receipt.success ||
    message.id !== receiptId ||
    message.userId !== ownerUserId ||
    message.threadId !== task.threadId ||
    message.catId !== null ||
    message.from?.kind !== 'user' ||
    message.from.userId !== ownerUserId ||
    message.source !== undefined ||
    extra?.collectiveAuthorizationInvalid !== undefined ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.sourceParseFailure ||
    receipt.data.sourceRef !== sourceRef ||
    receipt.data.catId !== task.ownerCatId
  ) {
    return undefined;
  }
  return { receiptRef, sourceRef, catId: receipt.data.catId };
}
