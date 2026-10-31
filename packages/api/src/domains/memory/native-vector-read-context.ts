import type { SqliteNativeReadContext } from '../../infrastructure/sqlite-read-diagnostics.js';

/** Only this existing passage KNN shape owns the two scalar observations. */
export function describePassageVectorRead(
  sql: string,
  bindings: readonly unknown[],
): SqliteNativeReadContext | undefined {
  const prefix = 'SELECT passage_key as passageKey, distance FROM passage_vectors';
  if (
    !sql.startsWith(prefix) ||
    sql.slice(prefix.length).trim().replace(/\s+/g, ' ') !== 'WHERE embedding MATCH ? AND k = ?'
  )
    return;
  const [vector, requestedK] = bindings;
  if (
    bindings.length !== 2 ||
    !(vector instanceof Float32Array) ||
    !Number.isSafeInteger(requestedK) ||
    (requestedK as number) < 0
  )
    return;
  return { kind: 'vector-knn', requestedK: requestedK as number, dimensions: vector.length };
}
