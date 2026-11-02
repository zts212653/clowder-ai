export function createDocumentReader(repository) {
  const cache = new Map();
  return async (userId, documentId) => {
    if (cache.has(documentId)) return cache.get(documentId);
    const document = await repository.find(documentId);
    if (!document || document.ownerId !== userId) return null;
    cache.set(documentId, document);
    return document;
  };
}
