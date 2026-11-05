import { isAbsolute } from 'node:path';
import type { AgyProfileConfig, ClientId } from '@cat-cafe/shared';
import { z } from 'zod';
import { resolveByAccountRef } from './account-resolver.js';

/** Member settings select the carrier and explicit automatic approval. */
export const agyNativeMemberSettingsSchema = z
  .object({
    enabled: z.boolean(),
    carrier: z.enum(['native', 'acp']),
    profileId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    homeRoot: z.string().trim().refine(isAbsolute, 'Profile root must be an absolute path').optional(),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use the actual AGY model ID'),
    autoApprove: z.boolean(),
    trustedWorkspaces: z.array(z.string().trim().refine(isAbsolute, 'Workspace must be an absolute path')).max(32),
  })
  .strict()
  .refine((profile) => profile.autoApprove || profile.trustedWorkspaces.length > 0, {
    message: 'Restricted AGY Native requires an approved workspace',
    path: ['trustedWorkspaces'],
  });

type MemberSettings = z.infer<typeof agyNativeMemberSettingsSchema>;

export function publicAgyProfile(profile?: AgyProfileConfig): AgyProfileConfig | undefined {
  return profile;
}

export function resolveAgyNativeMemberPatch(input: {
  projectRoot: string;
  requested: MemberSettings | null | undefined;
  current?: AgyProfileConfig;
  clientId: ClientId;
  acp: unknown;
  carrier?: string;
  model: string;
  accountRef?: string;
  previousAccountRef?: string;
  cliConfigArgs?: readonly string[];
}): AgyProfileConfig | null | undefined {
  if (input.requested === null) return null;
  const proposed = input.requested ?? input.current;
  const selectedAcp = input.carrier === 'acp' || (input.carrier === undefined && input.acp != null);
  if (input.requested?.carrier === 'acp' && (!selectedAcp || !input.acp))
    throw new Error('AGY ACP requires carrier=acp and an ACP launch configuration');
  if (proposed?.carrier === 'acp' && input.clientId === 'google' && selectedAcp && input.acp) {
    const account = resolveByAccountRef(input.projectRoot, input.accountRef ?? 'gemini');
    if (
      account &&
      (account.client !== 'google' || account.authType !== 'oauth' || Object.keys(account.envVars ?? {}).length)
    )
      throw new Error('AGY ACP requires personal OAuth with no account environment overrides');
    if (input.cliConfigArgs?.length) throw new Error('AGY ACP does not accept CLI extension arguments');
    if (proposed.model !== input.model) throw new Error('AGY ACP profile model must match the member model ID');
    return input.requested ?? undefined;
  }
  const leavesNativeClient = input.clientId !== 'google' || input.acp != null || selectedAcp;
  if (leavesNativeClient && input.requested) throw new Error('AGY Native requires Gemini without ACP');
  if (leavesNativeClient)
    return input.current?.carrier === 'native' || input.current?.carrier === 'acp' ? null : undefined;
  const next: AgyProfileConfig | undefined = input.requested ?? input.current;
  if (next?.carrier !== 'native') return undefined;
  const account = resolveByAccountRef(input.projectRoot, input.accountRef ?? 'gemini');
  if (account?.client !== 'google' || account.authType !== 'oauth' || Object.keys(account.envVars ?? {}).length) {
    throw new Error('AGY Native requires Gemini OAuth with no account environment overrides');
  }
  if (input.cliConfigArgs?.length) throw new Error('AGY Native does not accept CLI extension arguments');
  if (next.model !== input.model) throw new Error('AGY Native profile model must match the member model ID');
  return input.requested ?? undefined;
}
