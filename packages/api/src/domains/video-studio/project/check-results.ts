import { createHash } from 'node:crypto';
import {
  encodeVideoProjectCheckPageDefinition,
  type VideoProjectCheckPage,
  type VideoProjectCheckResult,
  type VideoProjectDocumentV1,
} from '@cat-cafe/shared';

/** Dedicated definition hash, shared with renderer imports; not an operation fingerprint. */
export function checkPageDefinitionDigest(page: VideoProjectCheckPage): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(encodeVideoProjectCheckPageDefinition(page), 'utf8').digest('hex')}`;
}

/** Validate newly admitted results against the actual saved input, never a later definition. */
export function assertCheckResultsBoundToInput(
  input: VideoProjectDocumentV1,
  results: readonly VideoProjectCheckResult[],
  inputOwnerRevision: number,
): void {
  const pages = new Map(input.checkPages.map((page) => [page.id, page]));
  const scenes = new Set(input.timeline.scenes.map((scene) => scene.id));
  const definitions = new Map<string, string>();
  for (const result of results) {
    const page = pages.get(result.pageId);
    if (!page || result.inputOwnerRevision !== inputOwnerRevision || !scenes.has(result.sceneId))
      throw new Error('Check result must bind the exact saved input and check page definition');
    const digest = definitions.get(page.id) ?? checkPageDefinitionDigest(page);
    definitions.set(page.id, digest);
    if (result.definitionDigest !== digest)
      throw new Error('Check result must bind the exact saved input and check page definition');
    assertPageApplies(page, result.sceneId);
    if (result.kind === 'coveredBy') assertPageApplies(pages.get(result.coveredByPageId), result.sceneId);
  }
}

function assertPageApplies(page: VideoProjectCheckPage | undefined, sceneId: string): void {
  if (!page || page.archivedAt || (page.scope.kind === 'selectedScenes' && !page.scope.sceneIds.includes(sceneId)))
    throw new Error('Check page does not apply to this scene');
}
