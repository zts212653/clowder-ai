import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ARCHIVE_SOURCE_REPOSITORY_URL } from '../archive-source-repository.js';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import { ArchiveIntegrityError, archiveRef, digestBytes } from './archive-reader.js';

export const CORTEX_ARCHIVE_ROOT = 'docs/videos/f311-microduck-roadshow/pipeline/cortex/evidence/20260910';
export const CORTEX_SOURCE_COMMIT = '35dfed114be3ca292aac304a888d4a9519d0dbea';
export const CORTEX_MANIFEST_SHA = 'f32db61d53e63b086fd9905a072d7b4335fc5acb3dbec8032bd699d54bf487a2';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const inventoryIdentitySchema = z.object({
  bytes: z.number().int().positive(),
  sha256: sha,
});
const inventorySchema = z.object({
  schema_version: z.literal(1),
  files: z
    .array(
      inventoryIdentitySchema.extend({
        path: z.string().max(240),
        // Public sync rewrites private locators inside two run manifests. The signed root
        // inventory names that exact exported byte identity; no arbitrary redaction is accepted.
        exported: inventoryIdentitySchema.optional(),
      }),
    )
    .max(128),
});
const manifestSchema = z.object({
  run_id: z.string().regex(/^[a-f0-9]{32}$/),
  seed: z.number().int(),
  mode: z.string().max(80),
  seconds: z.number().positive().max(86400),
  delay_s: z.number().nonnegative(),
  rules: z.string().max(120),
  source: z.object({
    lab_sha: z.string().regex(/^[a-f0-9]{40}$/),
    mujoco: z.string(),
    source_hashes: z.record(z.string(), sha),
    policies: z.record(z.string(), sha),
  }),
  scenario: z.object({
    name: z.string(),
    ducks: z.array(z.object({ id: z.string(), tof: z.string(), detector: z.string(), odom: z.string() })),
  }),
  control_hz: z.number().positive(),
  contact_hz: z.number().positive(),
  video_fps: z.number().positive(),
  actuator: z.string(),
  training: z.literal(false),
  local_skill: z.string().optional(),
});
const summarySchema = z.object({
  run_id: z.string(),
  sim_seconds: z.number().positive(),
  wall_seconds: z.number().positive(),
  team_scores: z.object({ gold: z.number().int().nonnegative(), blue: z.number().int().nonnegative() }),
  kick_starts: z.record(z.string(), z.number().int().nonnegative()),
  connected_kick_ids: z.array(z.string()).max(128),
  falls: z.record(z.string(), z.number().int().nonnegative()),
  accepted_commands: z.number().int().nonnegative(),
  rejected_commands: z.number().int().nonnegative(),
  max_lag_s: z.number().nonnegative(),
  p95_lag_s: z.number().nonnegative(),
});
const annotationSchema = z.object({
  run_id: z.string(),
  source: z.literal('match.mp4'),
  source_sha256: sha,
  source_observations_sha256: sha,
  observation_domain: z.string().max(500),
  label: z.string().max(500),
});
export const cortexSourceRef = archiveRef('cortex-publication', CORTEX_MANIFEST_SHA);
export const cortexHref = (path: string) =>
  `${ARCHIVE_SOURCE_REPOSITORY_URL}/blob/${CORTEX_SOURCE_COMMIT}/${CORTEX_ARCHIVE_ROOT}/${path}`;

export function createCortexReader(options: MicroduckLocalEvidenceOptions) {
  const rawRead = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const boundedRead = async (path: string) => {
    const bytes = await rawRead(resolve(options.repoRoot, CORTEX_ARCHIVE_ROOT, path));
    if (!bytes.byteLength || bytes.byteLength > 40_000_000) throw new ArchiveIntegrityError('Cortex read size invalid');
    return bytes;
  };
  const inventory = async () => {
    const bytes = await boundedRead('manifest.json');
    if (digestBytes(bytes) !== CORTEX_MANIFEST_SHA) throw new ArchiveIntegrityError('Cortex publication drift');
    return inventorySchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))).files;
  };
  const verified = async (path: string) => {
    if (
      !/^(cortex-793-live1|cortex-793-live2-state)\/(manifest\.json|summary\.json|annotation\.json|observations\.jsonl|match\.mp4|contact-sheet\.png)$/.test(
        path,
      )
    )
      throw new ArchiveIntegrityError('Cortex path outside signed inventory');
    const files = await inventory();
    const ref = files.find((entry) => entry.path === path);
    if (!ref) throw new ArchiveIntegrityError('Cortex file not published');
    const bytes = await boundedRead(path);
    const digest = digestBytes(bytes);
    const identities = [ref, ...(ref.exported ? [ref.exported] : [])];
    if (!identities.some((identity) => bytes.byteLength === identity.bytes && digest === identity.sha256))
      throw new ArchiveIntegrityError('Cortex file revision drift');
    return { bytes, ref };
  };
  const json = async (path: string) => JSON.parse(Buffer.from((await verified(path)).bytes).toString('utf8'));
  return {
    inventory,
    verified,
    async runs() {
      const runs = [];
      for (const id of ['cortex-793-live1', 'cortex-793-live2-state']) {
        const manifest = manifestSchema.parse(await json(`${id}/manifest.json`));
        const summary = summarySchema.parse(await json(`${id}/summary.json`));
        const annotation = annotationSchema.parse(await json(`${id}/annotation.json`));
        const observations = await verified(`${id}/observations.jsonl`);
        const first = z
          .object({ run_id: z.string(), observation_domain: z.string() })
          .parse(JSON.parse(Buffer.from(observations.bytes).toString('utf8').split('\n', 1)[0] ?? ''));
        const files = await inventory();
        const file = (name: string) => {
          const entry = files.find((entry) => entry.path === `${id}/${name}`);
          if (!entry) throw new ArchiveIntegrityError('Cortex run inventory incomplete');
          return entry;
        };
        if (
          manifest.run_id !== summary.run_id ||
          manifest.run_id !== annotation.run_id ||
          manifest.run_id !== first.run_id ||
          annotation.observation_domain !== first.observation_domain ||
          annotation.source_sha256 !== file('match.mp4').sha256 ||
          annotation.source_observations_sha256 !== observations.ref.sha256 ||
          Math.abs(manifest.seconds - summary.sim_seconds) > 0.01
        )
          throw new ArchiveIntegrityError('Cortex record escaped its run');
        runs.push({
          id,
          manifest,
          summary,
          annotation,
          manifestFile: file('manifest.json'),
          summaryFile: file('summary.json'),
          annotationFile: file('annotation.json'),
          videoFile: file('match.mp4'),
          posterFile: file('contact-sheet.png'),
        });
      }
      return runs;
    },
  };
}
export type CortexRun = Awaited<ReturnType<ReturnType<typeof createCortexReader>['runs']>>[number];
