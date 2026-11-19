import { readTasteMemoryById, visibleTasteMemories } from '../../dist/routes/taste-browse-reader.js';

export function createTasteBrowseFixture(repository, lifecycle) {
  const project = (owner, entry) => ({
    ...entry,
    takeawayCandidate: lifecycle?.candidateFor(owner, entry.sourcePath, entry.revision) ?? null,
  });
  return {
    async list(owner, privateAccess) {
      return (await visibleTasteMemories(repository, owner, privateAccess, lifecycle)).map((entry) => project(owner, entry));
    },
    async get(owner, memoryId, privateAccess) {
      const entry = await readTasteMemoryById(repository, owner, privateAccess, memoryId, lifecycle);
      return entry ? project(owner, entry) : null;
    },
    async actionSource(owner, memoryId, privateAccess) {
      const known = lifecycle?.sourcePathForMemoryId(owner, memoryId);
      if (known) return privateAccess || known.startsWith('docs/taste/vignettes/') ? known : null;
      return (await readTasteMemoryById(repository, owner, privateAccess, memoryId, lifecycle))?.sourcePath ?? null;
    },
  };
}
