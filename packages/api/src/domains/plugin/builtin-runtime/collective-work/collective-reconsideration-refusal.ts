/** A permanent refusal of one exact owner wake, before provider execution or callback effects. */
export class CollectiveReconsiderationRefusalError extends Error {
  readonly code = 'collective_reconsideration_refused';
  constructor(
    readonly sourceMessageId: string,
    readonly purposeKey: string,
    readonly reason: 'purpose_not_current' | 'permission_not_current',
    cause?: unknown,
  ) {
    super('This public owner wake no longer has its exact current source and permission purpose', { cause });
    this.name = 'CollectiveReconsiderationRefusalError';
  }
}
