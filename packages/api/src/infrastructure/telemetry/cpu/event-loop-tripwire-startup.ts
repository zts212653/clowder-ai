import { startEventLoopTripwire } from './event-loop-tripwire.js';

/** Observe initialization before any business startup callback; leave the observer running on success. */
export async function initializeWithEventLoopTripwire<T>(
  options: Parameters<typeof startEventLoopTripwire>[0],
  initialize: (tripwire: ReturnType<typeof startEventLoopTripwire>) => Promise<T>,
): Promise<T> {
  const tripwire = startEventLoopTripwire(options);
  try {
    // Readiness holds a bounded worker handshake reference even before the server exists.
    await tripwire.ready;
    return await initialize(tripwire);
  } catch (error) {
    await tripwire.close();
    throw error;
  }
}
