/**
 * F317: a Google Cloud platform account spends one Cloud project through Vertex AI. It holds no secret:
 * the owner declares it once, and the host reads this machine's standard Google Cloud login at send time.
 */
import { z } from 'zod';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';

/** Google Cloud project IDs: 6–30 lowercase letters, digits or hyphens, starting with a letter. */
export const GOOGLE_CLOUD_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

export const googleCloudAccountSchema = z
  .object({ credential: z.literal('local_adc'), projectId: z.string().regex(GOOGLE_CLOUD_PROJECT_ID) })
  .strict();

export function resolveGoogleCloudPlatformAccount(
  projectRoot: string,
  accountRef: string,
): { readonly projectId: string } | undefined {
  const { account } = readAccountStoreSnapshot(projectRoot).resolve(accountRef);
  if (account?.authType !== 'oauth' || account.clientId !== 'google' || !account.googleCloud) return undefined;
  return { projectId: googleCloudAccountSchema.parse(account.googleCloud).projectId };
}
