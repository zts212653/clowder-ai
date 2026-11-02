import { z } from 'zod';

const id = z.string().trim().min(1);
export const pawFeelRepairRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('task_assignment'), taskId: id, expectedOwnerRevision: z.number().int().nonnegative() })
    .strict(),
  z.object({ kind: z.literal('action_lease'), leaseId: id }).strict(),
]);
export type PawFeelRepairRequest = z.infer<typeof pawFeelRepairRequestSchema>;

export const pawFeelRepairBindingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task_assignment'),
      taskId: id,
      ownerRevision: z.number().int().nonnegative(),
      taskThreadId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal('action_lease'),
      taskId: id,
      leaseId: id,
      generation: z.number().int().nonnegative(),
      /** Null only when replaying old events which never recorded the holder thread. */
      holderThreadId: id.nullable(),
    })
    .strict(),
]);
export type PawFeelRepairBinding = z.infer<typeof pawFeelRepairBindingSchema>;

/** Legacy fields are history, never a second authorization path. */
export function pawFeelRepairBinding(value: {
  repairBinding?: PawFeelRepairBinding;
  taskId?: string;
  leaseId?: string;
  leaseGeneration?: number;
  actionLeaseRef?: { leaseId: string; generation: number };
}): PawFeelRepairBinding | undefined {
  if (value.repairBinding) return value.repairBinding;
  const leaseId = value.leaseId ?? value.actionLeaseRef?.leaseId;
  const generation = value.leaseGeneration ?? value.actionLeaseRef?.generation;
  return value.taskId && leaseId && generation !== undefined
    ? { kind: 'action_lease', taskId: value.taskId, leaseId, generation, holderThreadId: null }
    : undefined;
}

export function pawFeelRepairRequest(value: {
  repairBinding?: PawFeelRepairRequest;
  leaseId?: string;
}): PawFeelRepairRequest {
  return pawFeelRepairRequestSchema.parse(value.repairBinding ?? { kind: 'action_lease', leaseId: value.leaseId });
}

export function repairRequestForBinding(binding: PawFeelRepairBinding): PawFeelRepairRequest {
  return binding.kind === 'task_assignment'
    ? { kind: binding.kind, taskId: binding.taskId, expectedOwnerRevision: binding.ownerRevision }
    : { kind: binding.kind, leaseId: binding.leaseId };
}
