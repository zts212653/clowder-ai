import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const archiveNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .max(300);
export const archivePathSchema = z
  .string()
  .max(700)
  .regex(/^evidence\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/)
  .refine((path) => path.split('/').every((part) => part !== '.' && part !== '..'));
export const archiveFileRefSchema = z.object({ path: archivePathSchema, sha256: hash });
export const footballCaseSchema = z
  .object({
    id: archiveNameSchema,
    ballXY: z.tuple([z.number().finite(), z.number().finite()]),
    behavior: z.enum(['kick_left', 'kick_right']).nullable(),
    kickSeconds: z.number().finite().positive(),
    approach: z.boolean().optional(),
  })
  .passthrough();
const episodeSchema = z
  .object({
    capture: archiveNameSchema,
    case: footballCaseSchema,
    compressedSha256: hash,
    uncompressedSha256: hash,
    video: archiveNameSchema.nullable().optional(),
    metrics: z.object({ samples: z.number().int().min(1).max(100_000) }).passthrough(),
  })
  .passthrough();
export const footballIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('microduck_football_preparation_probe'),
    codeFiles: z.record(z.string().max(300), hash),
    repositoryHead: z.string().regex(/^[a-f0-9]{40}$/),
    runtimeDependencies: z.record(z.string(), z.string()),
    environment: z
      .object({
        episode: z
          .object({
            controlHz: z.number().positive(),
            physicsSubstepsPerControl: z.number().positive(),
            physicsTimestepSeconds: z.number().positive(),
          })
          .passthrough(),
        source: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    plan: z
      .object({
        actionScale: z.number().finite().positive(),
        modelFiles: z.record(z.string(), hash),
        observationLayout: z.string(),
        approachAlgorithm: z.string().optional(),
        approachController: z.record(z.string(), z.unknown()).optional(),
        durationSeconds: z.number().finite().positive().max(86_400),
        triggerSeconds: z.number().finite().nonnegative(),
        targetDirectionXY: z.tuple([z.number().finite(), z.number().finite()]),
        cases: z.array(footballCaseSchema).min(1).max(128),
        newTraining: z.literal(false),
        goalAccepted: z.literal(false),
        independentValidation: z.literal(false),
        changeFromPrevious: z
          .object({ reason: z.string(), changedParameters: z.array(z.string()) })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    episodes: z.array(episodeSchema).min(1).max(128),
  })
  .passthrough();
export const archiveManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.record(
      archiveNameSchema,
      z.object({ bytes: z.number().int().nonnegative().max(100_000_000), sha256: hash }),
    ),
  })
  .passthrough();

const baseRecord = {
  caseId: archiveNameSchema,
  captureRef: archiveFileRefSchema,
  uncompressedSha256: hash,
  videoRef: archiveFileRefSchema.nullable(),
  identicalCaptureReplayVideoRef: archiveFileRefSchema.nullable().optional(),
  mediaRunRef: archiveFileRefSchema.nullable().optional(),
};
export const footballCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('presentation_and_exploration_preparation_not_owner_truth'),
  formalGoalAccepted: z.literal(false),
  candidateAdopted: z.literal(false),
  versions: z
    .array(
      z.object({
        id: z.string().regex(/^v[0-9]+$/),
        parent: z.string().nullable(),
        change: z.string(),
        controllerFingerprintSha256: hash,
        runIds: z.array(archiveNameSchema).min(1),
      }),
    )
    .min(1)
    .max(128),
  runs: z
    .array(
      z.object({
        id: archiveNameSchema,
        versionId: z.string(),
        indexRef: archiveFileRefSchema,
        archiveManifestRef: archiveFileRefSchema,
      }),
    )
    .max(512),
  episodes: z.array(z.object({ ...baseRecord, runId: archiveNameSchema, versionId: z.string() })).max(4_096),
});
export const footballComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('public_short_approach_comparison'),
  formalGoalAccepted: z.literal(false),
  candidateAdopted: z.literal(false),
  newTraining: z.literal(false),
  exposure: z.literal('public_development'),
  runs: z
    .array(
      z.object({
        version: z.string().regex(/^v[0-9]+$/),
        indexRef: archiveFileRefSchema,
        controllerFingerprintSha256: hash,
      }),
    )
    .max(128),
  episodes: z.array(z.object({ ...baseRecord, version: z.string() })).max(4_096),
});

export const footballCaptureSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    case: footballCaseSchema,
    events: z
      .array(z.object({ kind: z.string(), seconds: z.number().finite().nonnegative() }).passthrough())
      .max(100_000),
    contacts: z
      .array(z.object({ seconds: z.number().finite().nonnegative(), robotBody: z.string() }).passthrough())
      .max(100_000),
    samples: z
      .array(
        z
          .object({
            seconds: z.number().finite().nonnegative(),
            robotPositionM: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
            ballPositionM: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
            robotQuaternionWxyz: z.tuple([
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
            ]),
          })
          .passthrough(),
      )
      .min(1)
      .max(100_000),
    metrics: z.object({ terminalReason: z.string().optional(), reason: z.string().optional() }).passthrough(),
  })
  .passthrough();

export type FootballIndex = z.infer<typeof footballIndexSchema>;
export type FootballEpisode = FootballIndex['episodes'][number];
export type FootballCase = z.infer<typeof footballCaseSchema>;
export type FootballCapture = z.infer<typeof footballCaptureSchema>;
export type FootballArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type FootballCatalog = z.infer<typeof footballCatalogSchema>;
export type FootballComparison = z.infer<typeof footballComparisonSchema>;
export type ArchiveFileRef = z.infer<typeof archiveFileRefSchema>;
export type ArchiveRecord = FootballCatalog['episodes'][number];
