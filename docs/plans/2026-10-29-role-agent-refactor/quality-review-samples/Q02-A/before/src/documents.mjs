export function createDocumentReader(repository) {
  return async (userId, documentId) => {
    const document = await repository.find(documentId);
    if (!document || document.ownerId !== userId) return null;
    return document;
  };
}
