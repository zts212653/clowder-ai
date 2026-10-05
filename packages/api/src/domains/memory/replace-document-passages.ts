import type Database from 'better-sqlite3';
import type { EvidenceItem } from './interfaces.js';
import { MARKDOWN_DOC_PASSAGE_PREFIX } from './MarkdownPassageIndexer.js';

export type DocumentPassageSource = {
  item: Pick<EvidenceItem, 'anchor' | 'sourcePath' | 'updatedAt'>;
  passages: string[];
};

import { passageVectorKey } from './PassageVectorStore.js';

export function replaceDocumentPassages(
  db: Database.Database,
  sources: DocumentPassageSource[],
  deleteVector?: (key: string) => void,
): void {
  const existingStmt = db.prepare(
    `SELECT passage_id AS passageId, content, created_at AS createdAt
       FROM evidence_passages
       WHERE doc_anchor = ? AND passage_id LIKE ?`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM evidence_passages
       WHERE doc_anchor = ? AND passage_id LIKE ?`,
  );
  const insertStmt = db.prepare(`
      INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  const tx = db.transaction((items: DocumentPassageSource[]) => {
    for (const source of items) {
      const passageLike = `${MARKDOWN_DOC_PASSAGE_PREFIX}%`;
      const oldPassages = existingStmt.all(source.item.anchor, passageLike) as Array<{
        passageId: string;
        content: string;
        createdAt: string;
      }>;
      const nextById = new Map<string, string>(
        source.passages.map((content, index) => [`${MARKDOWN_DOC_PASSAGE_PREFIX}${index}`, content]),
      );
      const oldById = new Map(oldPassages.map((passage) => [passage.passageId, passage]));
      for (const old of oldPassages) {
        if (nextById.get(old.passageId) !== old.content) {
          deleteVector?.(passageVectorKey(source.item.anchor, old.passageId));
        }
      }
      deleteStmt.run(source.item.anchor, passageLike);

      for (const [position, content] of source.passages.entries()) {
        const passageId = `${MARKDOWN_DOC_PASSAGE_PREFIX}${position}`;
        const old = oldById.get(passageId);
        insertStmt.run(
          source.item.anchor,
          passageId,
          content,
          null,
          position,
          old?.content === content ? old.createdAt : source.item.updatedAt,
        );
      }
    }
  });

  tx(sources);
}
