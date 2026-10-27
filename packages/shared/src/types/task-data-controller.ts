import { z } from 'zod';

const ref = z.string().trim().min(1).max(1_000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().finite();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const entrustedTaskDataControllerCoordinatesV1Schema = z.object({
  userId: ref,
  catId: ref,
  threadId: ref,
  subjectKey: ref,
  firstSourceRef: ref,
  admissionAuthorityRef: ref,
  pluginId: ref,
  pluginInstanceId: ref,
  moduleRef: ref,
  lifecycleRevision: revision,
});

const receiptBase = {
  receiptRef: ref.regex(/^task-data-controller:[a-f0-9]{64}$/),
  operationId: ref,
  payloadDigest: digest,
  actorRef: ref,
  operationKey: ref,
  actionId: ref,
  requestId: ref,
  confirmedAt: timestamp,
  recordedAt: timestamp,
};

export const entrustedTaskDataControllerReceiptV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      ...receiptBase,
      kind: z.literal('bind'),
      // Historical input is immutable evidence, never current API authority.
      controller: entrustedTaskDataControllerCoordinatesV1Schema.extend({ grantRevision: revision.optional() }),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal('revoke'),
      controllerReceiptRef: receiptBase.receiptRef,
    })
    .strict(),
]);

type DataControllerReceipt = z.infer<typeof entrustedTaskDataControllerReceiptV1Schema>;

export const entrustedTaskDataControllerV1Schema = z
  .object({
    bindingRevision: revision,
    state: z.enum(['active', 'revoked']),
    binding: entrustedTaskDataControllerCoordinatesV1Schema.extend({
      ownerOperationReceiptRef: receiptBase.receiptRef,
    }),
    receipts: z.array(entrustedTaskDataControllerReceiptV1Schema).min(1).max(256),
    revocationReceiptRef: receiptBase.receiptRef.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bindingRevision !== value.receipts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bindingRevision'],
        message: 'bindingRevision must identify the complete receipt history',
      });
    }
    const bindingReceipt = value.receipts.find(
      (receipt): receipt is Extract<DataControllerReceipt, { kind: 'bind' }> =>
        receipt.kind === 'bind' && receipt.receiptRef === value.binding.ownerOperationReceiptRef,
    );
    if (
      !bindingReceipt ||
      JSON.stringify(entrustedTaskDataControllerCoordinatesV1Schema.parse(bindingReceipt.controller)) !==
        JSON.stringify(stripBindingReceipt(value.binding))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binding'],
        message: 'binding must be backed by its exact owner-operation receipt',
      });
    }
    const revocationReceipt = value.revocationReceiptRef
      ? value.receipts.find(
          (receipt): receipt is Extract<DataControllerReceipt, { kind: 'revoke' }> =>
            receipt.kind === 'revoke' && receipt.receiptRef === value.revocationReceiptRef,
        )
      : undefined;
    if (
      (value.state === 'revoked' &&
        (!revocationReceipt || revocationReceipt.controllerReceiptRef !== value.binding.ownerOperationReceiptRef)) ||
      (value.state === 'active' && value.revocationReceiptRef !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revocationReceiptRef'],
        message: 'revocation state must be backed by the current binding receipt',
      });
    }
  });

function stripBindingReceipt(
  binding: z.infer<typeof entrustedTaskDataControllerV1Schema>['binding'],
): z.infer<typeof entrustedTaskDataControllerCoordinatesV1Schema> {
  const { ownerOperationReceiptRef: _receiptRef, ...coordinates } = binding;
  return coordinates;
}

export type EntrustedTaskDataControllerCoordinatesV1 = z.infer<typeof entrustedTaskDataControllerCoordinatesV1Schema>;
export type EntrustedTaskDataControllerReceiptV1 = DataControllerReceipt;
export type EntrustedTaskDataControllerV1 = z.infer<typeof entrustedTaskDataControllerV1Schema>;
