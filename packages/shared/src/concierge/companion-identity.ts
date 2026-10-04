import { z } from 'zod';

const actor = z
  .object({ catId: z.string().trim().min(1).max(160), displayName: z.string().trim().min(1).max(160) })
  .strict();
const verifiedModel = z.string().trim().min(1).max(160).nullable();

/** Saved with each Live message. The actual author and source stay on the message itself. */
export const companionIdentitySnapshotV1Schema = z
  .object({
    v: z.literal(1),
    name: z.literal('猫猫球'),
    partner: actor.extend({ skin: z.string().trim().min(1).max(160) }).strict(),
    live: actor.extend({ transport: z.literal('gpt_live_v3'), verifiedModel }).strict(),
    deep: actor.extend({ verifiedModel }).strict(),
  })
  .strict()
  .refine((snapshot) => snapshot.partner.catId === snapshot.deep.catId, {
    message: 'The chosen partner must be the named deep cat',
  });

export type CompanionIdentitySnapshotV1 = z.infer<typeof companionIdentitySnapshotV1Schema>;

/** Host-only input: selection comes from persisted user preference, never from an inbound message. */
export interface CompanionIdentitySelection {
  readonly duty: { readonly catId: string; readonly displayName: string };
  readonly carrier: { readonly catId: string; readonly displayName: string };
  readonly skin: string;
  readonly liveTransport: { readonly kind: 'gpt_live_v3'; readonly verifiedModel: string | null };
}

export function createCompanionIdentitySnapshot(
  selection: CompanionIdentitySelection,
  deepVerifiedModel: string | null = null,
): CompanionIdentitySnapshotV1 {
  return companionIdentitySnapshotV1Schema.parse({
    v: 1,
    name: '猫猫球',
    partner: { ...selection.duty, skin: selection.skin },
    live: {
      ...selection.carrier,
      transport: selection.liveTransport.kind,
      verifiedModel: selection.liveTransport.verifiedModel,
    },
    deep: { ...selection.duty, verifiedModel: deepVerifiedModel },
  });
}

export interface CompanionIdentityView {
  readonly title: '猫猫球';
  readonly partnerLabel: string;
  readonly avatarCatId: string;
  readonly skin: string;
  readonly liveLabel: string;
  readonly deepLabel: string;
}

/** Pure display projection. Its only input is the current Host state or saved message snapshot. */
export function projectCompanionIdentity(snapshot: CompanionIdentitySnapshotV1): CompanionIdentityView {
  return {
    title: snapshot.name,
    partnerLabel: `${snapshot.partner.displayName}陪伴中`,
    avatarCatId: snapshot.partner.catId,
    skin: snapshot.partner.skin,
    liveLabel: `Live 快端：${snapshot.live.displayName} · ${snapshot.live.verifiedModel ?? '型号未核实'}`,
    deepLabel: `深思端：${snapshot.deep.displayName} · ${snapshot.deep.verifiedModel ?? '型号未核实'}`,
  };
}
