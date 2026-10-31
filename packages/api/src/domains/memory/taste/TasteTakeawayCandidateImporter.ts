import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { TasteRepository } from '../../taste/services/TasteRepository.js';
import { resolveCanonicalTasteRoot } from '../../taste/services/TasteRepository.js';
import type { TasteMemoryLifecycleStore } from './TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from './TasteMemoryReader.js';

const candidateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('cat_draft_unconfirmed'),
    drafts: z.array(
      z
        .object({
          sourcePath: z.string().min(1),
          takeaway: z.string().trim().min(1).max(500),
          sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

const INPUT_PATHS = [
  'docs/features/evidence/F321/takeaway-drafts.public.json',
  'private/f321/takeaway-drafts.json',
] as const;

export interface TasteTakeawayCandidateImportResult {
  imported: number;
  stale: number;
  unavailableInputs: string[];
}

export async function importTasteTakeawayCandidates(input: {
  repository: TasteRepository;
  lifecycleStore: TasteMemoryLifecycleStore;
  ownerUserId: string;
}): Promise<TasteTakeawayCandidateImportResult> {
  let root: string;
  try {
    root = await resolveCanonicalTasteRoot(input.repository);
  } catch {
    // These optional installation drafts must not prevent a branch-only checkout
    // from starting. Publication still requires the repository's canonical main.
    return { imported: 0, stale: 0, unavailableInputs: [...INPUT_PATHS] };
  }
  const reader = new TasteMemoryReader(input.repository, input.ownerUserId, {
    lifecycle: input.lifecycleStore,
  });
  let imported = 0;
  let stale = 0;
  const unavailableInputs: string[] = [];
  for (const inputPath of INPUT_PATHS) {
    let parsed: z.infer<typeof candidateFileSchema>;
    try {
      parsed = candidateFileSchema.parse(JSON.parse(await readFile(join(root, inputPath), 'utf8')));
    } catch {
      unavailableInputs.push(inputPath);
      continue;
    }
    for (const draft of parsed.drafts) {
      const current = await reader.read({
        ownerUserId: input.ownerUserId,
        sourcePath: draft.sourcePath,
      });
      if (!current || current.revision !== draft.sourceRevision) {
        stale++;
        continue;
      }
      if (
        input.lifecycleStore.importCandidate({
          ownerUserId: input.ownerUserId,
          sourcePath: draft.sourcePath,
          sourceRevision: draft.sourceRevision,
          takeaway: draft.takeaway,
          sourceRef: inputPath,
        })
      ) {
        imported++;
      }
    }
  }
  return { imported, stale, unavailableInputs };
}
