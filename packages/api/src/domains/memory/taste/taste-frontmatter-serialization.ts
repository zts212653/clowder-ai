import { isDeepStrictEqual } from 'node:util';
import { type Document, isNode, isScalar, parseDocument, visit, type visitor } from 'yaml';
import { withoutTrailingWhitespace } from '../../taste/services/taste-text.js';

/**
 * Serialize an edited Taste frontmatter document between its markers, followed by the original
 * remainder. Returns undefined when no form reads back exactly as intended: a reader must never see
 * a value different from the one the command set, and the repository commit guard must never see a
 * line-end blank.
 */
export function serializeTasteFrontmatter(document: Document, remainder: string): string | undefined {
  cleanTasteDocumentText(document);
  // Without folding, no double-quoted scalar is split with an escaped space at a line end. What can
  // still end in blanks is only the indentation of an empty block-scalar line.
  let serialized = document
    .toString({ lineWidth: 0 })
    .split('\n')
    .map((line) => (/^[ \t]+$/.test(line) ? '' : line))
    .join('\n');
  if (!serialized.endsWith('\n')) serialized += '\n';
  const intended = document.toJS();
  // The reader drops the newline before the closing marker; a final block scalar may need one more.
  for (const content of [`---\n${serialized}---${remainder}`, `---\n${serialized}\n---${remainder}`]) {
    if (readsBackFaithfully(content, intended)) return content;
  }
  return undefined;
}

/**
 * The repository commit guard rejects line-end blanks. Clean what is text in a value or a comment,
 * never a key, after converting plain JS values a command set (corrections, takeaway, status) into nodes.
 */
function cleanTasteDocumentText(document: Document): void {
  cleanComments(document);
  // A comment written above a key is attached to the key node; it is cleaned, the key itself is not.
  const keyComments: visitor = { Node: (_key, node) => cleanComments(node) };
  const cleaner: visitor = {
    // Descend into the value only: no key text, however deep, is changed.
    Pair(_key, pair) {
      if (isNode(pair.key)) visit(pair.key, keyComments);
      if (pair.value !== null && !isNode(pair.value)) pair.value = document.createNode(pair.value);
      if (isNode(pair.value)) visit(pair.value, cleaner);
      return visit.SKIP;
    },
    Node(_key, node) {
      cleanComments(node);
      if (isScalar(node) && typeof node.value === 'string') node.value = withoutTrailingWhitespace(node.value);
    },
  };
  visit(document, cleaner);
}

function cleanComments(node: { commentBefore?: string | null; comment?: string | null }): void {
  if (node.commentBefore) node.commentBefore = withoutTrailingWhitespace(node.commentBefore);
  if (node.comment) node.comment = withoutTrailingWhitespace(node.comment);
}

/** Read the result exactly as TasteMemoryReader does and require the intended values, without line-end blanks. */
function readsBackFaithfully(content: string, intended: unknown): boolean {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return false;
  if (frontmatter.split('\n').some((line) => /[ \t\r\v\f]$/.test(line))) return false;
  const reread = parseDocument(frontmatter);
  if (reread.errors.length > 0) return false;
  try {
    return isDeepStrictEqual(reread.toJS({ maxAliasCount: 0 }), intended);
  } catch {
    return false;
  }
}
