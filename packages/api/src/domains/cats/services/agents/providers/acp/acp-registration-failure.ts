import type { CreateAcpServiceForConfigInput } from './AcpServiceFactory.js';

/** Retire a skipped member's pool and project only its safe registration diagnostic. */
export async function skipAcpProfile(
  input: CreateAcpServiceForConfigInput,
  reason: string,
  logPayload: Record<string, unknown>,
  message: string,
  publicReason?: string,
): Promise<null> {
  input.log.warn(logPayload, message);
  // Only an explicitly safe account verdict may replace the fixed diagnostic.
  // logPayload can contain secrets in raw spawn errors and must remain out of this projection.
  input.onUnavailable?.({ code: reason, message: publicReason ?? message });
  const existingPool = input.poolRegistry.get(input.profileId);
  if (existingPool) {
    try {
      await existingPool.closeAll();
    } catch (err) {
      input.log.warn(
        { err, profileId: input.profileId, reason },
        'ACP registry sync failed to close skipped member pool',
      );
    } finally {
      input.poolRegistry.delete(input.profileId);
    }
  }
  return null;
}
