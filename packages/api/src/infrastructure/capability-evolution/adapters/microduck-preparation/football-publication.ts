import { createHash } from 'node:crypto';
import {
  type EvolutionPreparationMediaRequestV1,
  type EvolutionResolvedPreparationReviewV1,
  evolutionPreparationGroupV1Schema,
  type OwnerTruthRefV1,
  timestampSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { MicroduckBlocked } from '../microduck-owner-contract.js';
import { PROGRAM_ADAPTER_MEDIA_MAX_BYTES } from '../program-adapter-media-contract.js';

type ReadBytes = (path: string) => Promise<Uint8Array>;
type PreparationGroup = EvolutionResolvedPreparationReviewV1['groups'][number];

export const MICRODUCK_FOOTBALL_PUBLICATION_PATH =
  'docs/videos/f311-microduck-roadshow/pipeline/football/workspace-publication.json';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const stateRef = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[a-z][a-z0-9-]*:[^\s{}[\]"']*$/u);
const resourcePath = z
  .string()
  .min(1)
  .max(700)
  .refine(
    (value) =>
      /^docs\/videos\/f311-microduck-roadshow\/pipeline\/football\/[a-zA-Z0-9._/-]+$/u.test(value) ||
      /^docs\/videos\/f311-microduck-roadshow\/briefing\/[a-zA-Z0-9._/-]+$/u.test(value),
    'football publication resources must stay inside the public archive',
  )
  .refine(
    (value) =>
      !value.includes('\\') &&
      value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'unsafe football publication path',
  );
const fact = z.object({ label: z.string().min(1).max(120), value: z.string().min(1).max(2_000) }).strict();
const resourceBase = {
  label: z.string().min(1).max(240),
  path: resourcePath,
  sha256: hash,
};
const resource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), ...resourceBase }).strict(),
  z
    .object({
      kind: z.literal('video'),
      ...resourceBase,
      contentType: z.enum(['video/mp4', 'video/webm']),
      durationSeconds: z.number().finite().positive().max(86_400).optional(),
    })
    .strict(),
]);
const activity = z
  .object({
    state: z.enum(['running', 'completed', 'awaiting_publication', 'failed']),
    updatedAt: timestampSchema,
    detail: z.string().min(1).max(2_000).optional(),
  })
  .strict();
const publicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerFeatureId: z.literal('microduck-owner'),
    objectStateRef: z.literal('simulator:walking'),
    resourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    updatedAt: timestampSchema,
    groups: z
      .array(
        z
          .object({
            groupStateRef: stateRef,
            title: z.string().min(1).max(240),
            items: z
              .array(
                z
                  .object({
                    materialStateRef: stateRef,
                    title: z.string().min(1).max(240),
                    summary: z.string().min(1).max(4_000),
                    status: z.enum(['available', 'planned', 'unavailable']),
                    activity: activity.optional(),
                    facts: z.array(fact).max(12),
                    resources: z.array(resource).max(32),
                  })
                  .strict(),
              )
              .max(128),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const groupRefs = value.groups.map((group) => group.groupStateRef);
    const itemRefs = value.groups.flatMap((group) => group.items.map((item) => item.materialStateRef));
    const mediaHashes = value.groups.flatMap((group) =>
      group.items.flatMap((item) =>
        item.resources.filter((entry) => entry.kind === 'video').map((entry) => entry.sha256),
      ),
    );
    if (new Set(groupRefs).size !== groupRefs.length || new Set(itemRefs).size !== itemRefs.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'football publication refs must be unique' });
    if (new Set(mediaHashes).size !== mediaHashes.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'football publication media must be unique' });
    const publishedAt = Date.parse(value.updatedAt);
    if (
      value.groups.some((group) =>
        group.items.some((item) => item.activity && Date.parse(item.activity.updatedAt) > publishedAt),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'football activity cannot be newer than its publication',
      });
  });

type FootballPublication = z.infer<typeof publicationSchema>;
type FootballResource = FootballPublication['groups'][number]['items'][number]['resources'][number];

export interface MicroduckFootballPreparationPublication {
  groups: PreparationGroup[];
  sourceRef: OwnerTruthRefV1;
  updatedAt: string;
}

export interface MicroduckPreparationMediaAsset {
  status: 'resolved';
  mediaRef: OwnerTruthRefV1;
  kind: 'video';
  contentType: 'video/mp4' | 'video/webm';
  bytes: Uint8Array;
}

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const ownerRef = (ownerStateRef: string, version?: string): OwnerTruthRefV1 => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef,
  ...(version ? { version } : {}),
});
const sourceRef = (entry: FootballResource): OwnerTruthRefV1 =>
  ownerRef(`${entry.kind === 'video' ? 'preparation-media' : 'repo-material'}:sha256:${entry.sha256}`, entry.sha256);
const ownerHref = (publication: FootballPublication, path: string): string =>
  `https://github.com/zts212653/clowder-ai/blob/${publication.resourceCommit}/${path}`;

async function readPublication(readBytes: ReadBytes): Promise<{ bytes: Uint8Array; value: FootballPublication }> {
  const bytes = await readBytes(MICRODUCK_FOOTBALL_PUBLICATION_PATH);
  return { bytes, value: publicationSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))) };
}

async function verifyDocuments(publication: FootballPublication, readBytes: ReadBytes): Promise<boolean> {
  const documents = publication.groups.flatMap((group) =>
    group.items.flatMap((item) => item.resources.filter((entry) => entry.kind === 'document')),
  );
  const values = await Promise.all(documents.map(async (entry) => [entry, await readBytes(entry.path)] as const));
  return values.every(([entry, bytes]) => sha256(bytes) === entry.sha256);
}

function projectGroup(publication: FootballPublication, group: FootballPublication['groups'][number]) {
  return evolutionPreparationGroupV1Schema.parse({
    groupRef: ownerRef(group.groupStateRef),
    title: group.title,
    items: group.items.map((item) => ({
      materialRef: ownerRef(item.materialStateRef),
      title: item.title,
      summary: item.summary,
      status: item.status,
      ...(item.activity ? { activity: item.activity } : {}),
      facts: item.facts,
      resources: item.resources.map((entry) => {
        const exactSourceRef = sourceRef(entry);
        return {
          label: entry.label,
          sourceRef: exactSourceRef,
          ownerHref: ownerHref(publication, entry.path),
          ...(entry.kind === 'video'
            ? {
                media: {
                  mediaRef: exactSourceRef,
                  contentType: entry.contentType,
                  ...(entry.durationSeconds ? { durationSeconds: entry.durationSeconds } : {}),
                },
              }
            : {}),
        };
      }),
    })),
  });
}

/** Reads the owner publication on every request; video bytes remain lazy until explicit playback. */
export async function readMicroduckFootballPreparationPublication(
  readBytes: ReadBytes,
): Promise<MicroduckFootballPreparationPublication | undefined> {
  try {
    const publication = await readPublication(readBytes);
    if (!(await verifyDocuments(publication.value, readBytes))) return undefined;
    const manifestHash = sha256(publication.bytes);
    return {
      groups: publication.value.groups.map((group) => projectGroup(publication.value, group)),
      sourceRef: ownerRef(`preparation-publication:sha256:${manifestHash}`, manifestHash),
      updatedAt: publication.value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

/** Resolves only media that remains present in the current owner publication and verifies exact bytes. */
export async function readMicroduckFootballPreparationMedia(
  readBytes: ReadBytes,
  input: EvolutionPreparationMediaRequestV1,
): Promise<MicroduckPreparationMediaAsset | MicroduckBlocked> {
  try {
    const { value } = await readPublication(readBytes);
    const entry = value.groups
      .flatMap((group) => group.items)
      .flatMap((item) => item.resources)
      .find(
        (candidate) =>
          candidate.kind === 'video' &&
          input.mediaRef.ownerFeatureId === 'microduck-owner' &&
          input.mediaRef.ownerStateRef === `preparation-media:sha256:${candidate.sha256}` &&
          input.mediaRef.version === candidate.sha256,
      );
    if (!entry || entry.kind !== 'video') return { status: 'blocked', code: 'preparation_media_unavailable' };
    const bytes = await readBytes(entry.path);
    if (bytes.byteLength === 0 || bytes.byteLength > PROGRAM_ADAPTER_MEDIA_MAX_BYTES || sha256(bytes) !== entry.sha256)
      return { status: 'blocked', code: 'artifact_hash_mismatch' };
    return {
      status: 'resolved',
      mediaRef: sourceRef(entry),
      kind: 'video',
      contentType: entry.contentType,
      bytes,
    };
  } catch {
    return { status: 'blocked', code: 'preparation_media_unavailable' };
  }
}
