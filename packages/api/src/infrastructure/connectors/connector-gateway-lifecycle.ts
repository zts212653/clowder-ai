/**
 * Connector Gateway Lifecycle — F136 Phase 2
 *
 * Restart = stop old handle → start new handle with fresh config.
 * Intentionally decoupled from bootstrap internals via startFn injection.
 */

interface Stoppable {
  stop(): Promise<void>;
}

/**
 * Restart the connector gateway.
 *
 * @param oldHandle - Current gateway handle (null if first start)
 * @param startFn - Factory that creates a new gateway handle (reads fresh process.env)
 * @returns New handle, or null if no connectors configured
 */
export async function restartConnectorGateway<T extends Stoppable>(
  oldHandle: T | null,
  startFn: () => Promise<T | null>,
): Promise<T | null> {
  if (oldHandle) {
    await oldHandle.stop();
  }
  return startFn();
}
