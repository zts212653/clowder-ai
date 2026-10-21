import type { AlphaRevisionConsumer, DurableManagedGateJob, ManagedJobSource } from './managed-job-types.js';

export type { ManagedJobSource } from './managed-job-types.js';

export function validAlphaRevisionConsumer(value: unknown): value is AlphaRevisionConsumer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    input.kind === 'alpha_revision_v1' &&
    typeof input.subscriptionId === 'string' &&
    input.subscriptionId.length > 0 &&
    input.subscriptionId.length <= 128 &&
    typeof input.s3JobId === 'string' &&
    /^alpha-browser-[a-f0-9]{64}$/u.test(input.s3JobId) &&
    typeof input.headSha === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.headSha) &&
    typeof input.baseSha === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.baseSha) &&
    input.baseSha !== input.headSha
  );
}

export function validManagedJobSource(source: ManagedJobSource, consumer: unknown, originTaskId: string): boolean {
  if (consumer !== undefined) {
    return (
      validAlphaRevisionConsumer(consumer) &&
      source.originInvocationId === undefined &&
      source.originScheduleId === consumer.subscriptionId &&
      originTaskId === consumer.subscriptionId
    );
  }
  return (
    typeof source.originInvocationId === 'string' &&
    source.originInvocationId.length > 0 &&
    source.originScheduleId === undefined
  );
}

export function parseScheduleAdmission(value: unknown): { scheduleId: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scheduleId = (value as Record<string, unknown>).scheduleId;
  return typeof scheduleId === 'string' && scheduleId ? { scheduleId } : undefined;
}

export function isManagedJobAdmitted(
  job: DurableManagedGateJob,
  record: {
    readonly admissionMessageId?: unknown;
    readonly scheduleAdmission?: unknown;
  } | null,
): boolean {
  if (!record) return false;
  if (job.kind === 'alpha_revision_v1') {
    return (
      validAlphaRevisionConsumer(job.consumer) &&
      parseScheduleAdmission(record.scheduleAdmission)?.scheduleId === job.consumer.subscriptionId &&
      job.definition?.originScheduleId === job.consumer.subscriptionId
    );
  }
  return typeof record.admissionMessageId === 'string' && record.admissionMessageId.length > 0;
}
