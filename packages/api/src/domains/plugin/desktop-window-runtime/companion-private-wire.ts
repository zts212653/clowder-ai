// Pin the existing legacy Companion ABI independently of the current manifest schema.

import {
  type CompanionCommand as DeskCompanionCommand,
  type CompanionReply as DeskCompanionReply,
  validateCompanionCommand as validateDeskCompanionCommand,
  validateCompanionReply as validateDeskCompanionReply,
} from '@clowder-ai/plugin-contract-033c0';
import {
  type CompanionCommand,
  type CompanionReply,
  type CompanionState,
  validateCompanionCommand,
  validateCompanionReply,
} from '@clowder-ai/plugin-contract-beta21';
import {
  type CompanionCommand as ModernCompanionCommand,
  type CompanionReply as ModernCompanionReply,
  validateCompanionCommand as validateModernCompanionCommand,
  validateCompanionReply as validateModernCompanionReply,
} from '@clowder-ai/plugin-contract-beta23';
import {
  type CompanionCommand as UnifiedCompanionCommand,
  type CompanionReply as UnifiedCompanionReply,
  validateCompanionCommand as validateUnifiedCompanionCommand,
  validateCompanionReply as validateUnifiedCompanionReply,
} from '@clowder-ai/plugin-contract-beta24';
import {
  validateCompanionCommand as validateWorkCompanionCommand,
  validateCompanionReply as validateWorkCompanionReply,
  type CompanionCommand as WorkCompanionCommand,
  type CompanionReply as WorkCompanionReply,
} from '@clowder-ai/plugin-contract-beta25';
import {
  type CompanionMeetingState,
  type CompanionCommand as PresentationCompanionCommand,
  type CompanionReply as PresentationCompanionReply,
  validateCompanionCommand as validatePresentationCompanionCommand,
  validateCompanionReply as validatePresentationCompanionReply,
} from '@clowder-ai/plugin-contract-beta27';
import {
  type CompanionCommand as LetterCompanionCommand,
  type CompanionReply as LetterCompanionReply,
  validateCompanionCommand as validateLetterCompanionCommand,
  validateCompanionReply as validateLetterCompanionReply,
} from '@clowder-ai/plugin-contract-beta28';
import {
  type CompanionCommand as AppAssistCompanionCommand,
  type CompanionReply as AppAssistCompanionReply,
  validateCompanionCommand as validateAppAssistCommand,
  validateCompanionReply as validateAppAssistReply,
} from '@clowder-ai/plugin-contract-beta29';
import { z } from 'zod';
import { type CompanionContract, companionContractHas } from './published-companion-v2.js';

// SDP exists only on the private pipe between the Host-owned preload/kernel/API.
// Never use this validator on the package-facing renderer IPC handler.
const sdp = z
  .string()
  .max(128000)
  .refine((value) => value.startsWith('v=0') && /^m=audio /m.test(value) && !/^m=video /m.test(value));
const offer = z.object({ kind: z.literal('offer'), sdp }).strict();
const callId = z.string().uuid();
const tasteProposalId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const answer = z.object({ kind: z.literal('answer'), sdp, callId }).strict();
export const hostF221Preview = z
  .object({
    kind: z.literal('f221-preview'),
    snapshot: z
      .object({
        proposalId: tasteProposalId,
        ownerUserId: z.string().min(1),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        nonce: z.string().regex(/^[0-9a-f]{48}$/),
        expiresAt: z.number().int().positive(),
        fields: z
          .object({
            id: z.string(),
            userId: z.string(),
            catId: z.string(),
            threadId: z.string(),
            sourceMessageId: z.string(),
            scene: z.string().max(16000),
            quote: z.string().max(16000),
            resolvedQuotes: z.string().max(32000),
            takeaway: z.string().max(16000),
            tags: z.string().max(16000),
            dimension: z.string(),
            privacy: z.enum(['public', 'sensitive']),
            createdAt: z.string(),
            approvalOriginRef: z.string(),
            correctionTarget: z.string().max(32000),
            publication: z.string().max(32000),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type HostF221Preview = z.infer<typeof hostF221Preview>;
const f221ConfirmTrial = z
  .object({
    kind: z.literal('f221.confirm-trial'),
    nonce: z.string().regex(/^[0-9a-f]{48}$/),
    action: z.enum(['approve', 'reject']),
  })
  .strict();
const f221TrialReceipt = z
  .object({
    kind: z.literal('f221-trial-receipt'),
    origin: z.literal('host-native-dialog'),
    nonce: z.string().regex(/^[0-9a-f]{48}$/),
    proposalId: tasteProposalId,
    ownerUserId: z.string().min(1),
    hostGeneration: z.number().int().nonnegative(),
    callId: z.string().uuid().optional(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    action: z.enum(['approve', 'reject']),
    confirmedAt: z.number().int().positive(),
  })
  .strict();
export type HostF221TrialReceipt = z.infer<typeof f221TrialReceipt>;
const nativeId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
/** Host media principal only; never admitted as a package CompanionCommand/Event. */
const observationFence = { observedAt: z.number().int().nonnegative(), callId, eventId: nativeId };
export const hostVoiceObservation = z.discriminatedUnion('stage', [
  z.object({ ...observationFence, stage: z.literal('first_audio_output'), turnId: nativeId }).strict(),
  z.object({ ...observationFence, stage: z.literal('owner_voice_completed'), turnId: nativeId }).strict(),
  z
    .object({
      ...observationFence,
      stage: z.literal('first_outward_text'),
      nativeItemId: nativeId,
      turnId: nativeId.optional(),
    })
    .strict(),
]);
export type HostVoiceObservation = z.infer<typeof hostVoiceObservation>;
/** The fixed Host preload timestamps request entry; the package never supplies this private field. */
export const hostTextSubmission = z
  .object({
    stage: z.literal('client_text_sent'),
    observedAt: z.number().int().nonnegative(),
    clientMessageId: z.string().regex(/^[^\s\u0000-\u001f\u007f]{1,256}$/),
  })
  .strict();
export type HostTextSubmission = z.infer<typeof hostTextSubmission>;
const workKind = z.enum(['reasoning', 'tool', 'workspace_fetch', 'workspace_dispatch', 'screen_read']);
const workEntry = z
  .object({
    taskId: z.string().min(1).max(500),
    nativeTurnId: nativeId,
    kind: workKind,
    startedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const workEvent = z
  .object({
    eventId: z.string().min(1).max(500),
    taskId: z.string().min(1).max(500),
    kind: z.union([workKind, z.literal('result')]),
    phase: z.enum(['started', 'completed', 'failed', 'cancelled', 'expired', 'result_handed_to_voice']),
    occurredAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    resultId: z.string().min(1).max(500).optional(),
    nativeCarrierCatId: z.string().min(1).max(160).optional(),
  })
  .strict();
export const hostNativeWork = z
  .object({
    scopeId: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .nullable(),
    revision: z.number().int().nonnegative(),
    active: z.array(workEntry).max(64),
    recent: z.array(workEvent).max(16),
  })
  .strict();
export type HostNativeWork = z.infer<typeof hostNativeWork>;
const liveTransport = z.object({ kind: z.literal('gpt_live_v3'), verifiedModel: z.null() }).strict();
export type HostCompanionState = CompanionState & {
  /** beta.27 requires a read-only meeting projection; legacy replies omit it. */
  readonly meeting?: CompanionMeetingState;
  /** Private native policy; removed before delivering the beta.21 renderer state. */
  readonly behaviorEnabled: boolean;
  readonly nativeWork: HostNativeWork;
  readonly liveTransport: z.infer<typeof liveTransport>;
};
const hostStateExtras = z
  .object({
    kind: z.literal('state'),
    nativeWork: hostNativeWork,
    liveTransport,
    behaviorEnabled: z.boolean().optional(),
  })
  .passthrough();
export type HostCompanionCommand =
  | Exclude<CompanionCommand, { kind: `audio.${string}` }>
  | Exclude<ModernCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<UnifiedCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<WorkCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<PresentationCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<LetterCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<AppAssistCompanionCommand, { kind: `audio.${string}` }>
  | Exclude<DeskCompanionCommand, { kind: `audio.${string}` }>
  | z.infer<typeof offer>
  | z.infer<typeof f221ConfirmTrial>;
export type HostCompanionReply =
  | CompanionReply
  | ModernCompanionReply
  | UnifiedCompanionReply
  | WorkCompanionReply
  | PresentationCompanionReply
  | LetterCompanionReply
  | AppAssistCompanionReply
  | DeskCompanionReply
  | HostCompanionState
  | z.infer<typeof answer>
  | HostF221Preview
  | z.infer<typeof f221TrialReceipt>;
/** The public command and reply schema of each admitted contract line. */
type PublicSchema = (value: unknown) => value is { kind: string };
const PUBLIC_COMMANDS: Record<CompanionContract, PublicSchema> = {
  '0.1.0-beta.21': validateCompanionCommand,
  '0.1.0-beta.23': validateModernCompanionCommand,
  '0.1.0-beta.24': validateUnifiedCompanionCommand,
  '0.1.0-beta.25': validateWorkCompanionCommand,
  '0.1.0-beta.27': validatePresentationCompanionCommand,
  '0.1.0-beta.28': validateLetterCompanionCommand,
  '0.1.0-beta.29': validateAppAssistCommand,
  '0.3.3-candidate.0': validateDeskCompanionCommand,
};
const PUBLIC_REPLIES: Record<CompanionContract, PublicSchema> = {
  '0.1.0-beta.21': validateCompanionReply,
  '0.1.0-beta.23': validateModernCompanionReply,
  '0.1.0-beta.24': validateUnifiedCompanionReply,
  '0.1.0-beta.25': validateWorkCompanionReply,
  '0.1.0-beta.27': validatePresentationCompanionReply,
  '0.1.0-beta.28': validateLetterCompanionReply,
  '0.1.0-beta.29': validateAppAssistReply,
  '0.3.3-candidate.0': validateDeskCompanionReply,
};
export function validateHostCompanionCommand(
  value: unknown,
  contract: CompanionContract = '0.1.0-beta.21',
): value is HostCompanionCommand {
  const validatePublic = PUBLIC_COMMANDS[contract];
  if (!validatePublic) return false;
  return (
    (validatePublic(value) && !value.kind.startsWith('audio.')) ||
    offer.safeParse(value).success ||
    f221ConfirmTrial.safeParse(value).success
  );
}
export function validateHostCompanionReply(
  value: unknown,
  contract: CompanionContract = '0.1.0-beta.21',
): value is HostCompanionReply {
  const validatePublic = PUBLIC_REPLIES[contract];
  if (!validatePublic) return false;
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'state') {
    const parsed = hostStateExtras.safeParse(value);
    if (!parsed.success) return false;
    // Private API state contains only the existing letter base. The trusted desktop session adds its own
    // app-assist offer (and, from 0.3.3, the desk) and validates the complete reply of that line there.
    if (companionContractHas(contract, 'appAssist'))
      return !('appAssist' in parsed.data) && !('desk' in parsed.data) && validateLetterCompanionReply(parsed.data);
    const { behaviorEnabled: _nativePolicy, ...publicState } = parsed.data;
    return validatePublic(contract === '0.1.0-beta.21' ? publicState : parsed.data);
  }
  return (
    validatePublic(value) ||
    answer.safeParse(value).success ||
    hostF221Preview.safeParse(value).success ||
    f221TrialReceipt.safeParse(value).success
  );
}
