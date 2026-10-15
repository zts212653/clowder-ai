/** Local stream cancellation; native termination must be proved separately. */
export class AcpSessionCancelledError extends Error {
  readonly code = 'SESSION_CANCELLED';
  readonly nativeAcknowledged = false;
  constructor(readonly sessionId: string) {
    super(`ACP session ${sessionId} cancelled locally; native acknowledgement pending`);
    this.name = 'AcpSessionCancelledError';
  }
}
