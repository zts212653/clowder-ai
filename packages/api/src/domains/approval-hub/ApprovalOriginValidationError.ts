/** A deterministic rejection of the stored origin, distinct from an unavailable source store. */
export class ApprovalOriginValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApprovalOriginValidationError';
  }
}
