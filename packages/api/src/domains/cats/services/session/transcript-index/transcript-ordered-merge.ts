const FIELDS = ['source', 'seq', 'event_no', 'invocation_id', 'hash', 'byte_offset', 'byte_length'];

/**
 * Merge compact source rows by their shared positions, retaining counted duplicates.
 * Source fragments may be a prefix, suffix, or have a failed disk append in the middle.
 * A newer disk suffix must remain after the frozen buffer, rather than moving ahead of it.
 * Only pointers cross the window sorts; the caller materializes projections after ordering.
 * Queries are internal literals; all payloads stay in the existing JSONL/buffer sources.
 */
export function orderedTranscriptMergeSql(
  primaryQuery: string,
  supplementalQuery: string,
  matchEventNo = false,
  rankOnlyMatchingPrimary = matchEventNo,
): string {
  // Live JSONL and its buffer share original append coordinates. Published
  // JSONL has rewritten coordinates, so its cross-source overlap remains counted.
  const identity = matchEventNo ? 'hash, event_no' : 'hash';
  const primaryFields = FIELDS.map((field) => `p.${field}`).join(', ');
  const supplementalFields = FIELDS.map((field) => `s.${field}`).join(', ');
  // Only live identities present in the buffer need occurrence ranks. Keep every
  // occurrence of each matching (hash, event_no), including sparse/duplicate rows.
  // Unmatched live rows and the tail position still come from the complete source.
  const sparsePrimary = matchEventNo && rankOnlyMatchingPrimary;
  const primaryFilter = sparsePrimary
    ? ' WHERE (hash, event_no) IN (SELECT hash, event_no FROM supplemental_rows)'
    : '';
  const unmatchedPrimary = sparsePrimary
    ? `(${primaryQuery}) p`
    : `primary_rows p LEFT JOIN supplemental_rows s USING (${identity}, occurrence)`;
  const unmatchedCondition = sparsePrimary
    ? 'NOT EXISTS (SELECT 1 FROM matched s WHERE s.primary_position = p.order_no)'
    : 's.order_no IS NULL';
  const tailSource = sparsePrimary ? `(${primaryQuery})` : 'primary_rows';
  return `
    WITH primary_rows AS (
      SELECT ${FIELDS.join(', ')}, order_no,
        ROW_NUMBER() OVER (PARTITION BY ${identity} ORDER BY order_no) AS occurrence
      FROM (${primaryQuery})${primaryFilter}
    ), supplemental_rows AS (
      SELECT ${FIELDS.join(', ')}, order_no,
        ROW_NUMBER() OVER (PARTITION BY ${identity} ORDER BY order_no) AS occurrence
      FROM (${supplementalQuery})
    ), matched AS (
      SELECT s.*, p.order_no AS primary_position
      FROM supplemental_rows s LEFT JOIN primary_rows p USING (${identity}, occurrence)
    ), positioned AS (
      SELECT *,
        MIN(primary_position) OVER (ORDER BY order_no ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_position,
        MAX(primary_position) OVER (ORDER BY order_no ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_position
      FROM matched
    ), merged AS (
      SELECT p.order_no AS position, 1 AS slot, p.order_no AS item_order, ${primaryFields}
      FROM ${unmatchedPrimary}
      WHERE ${unmatchedCondition}
      UNION ALL
      SELECT COALESCE(s.primary_position, s.next_position, s.previous_position + 1,
        (SELECT COALESCE(MAX(order_no) + 1, 0) FROM ${tailSource})),
        CASE WHEN s.primary_position IS NULL THEN 0 ELSE 1 END, s.order_no, ${supplementalFields}
      FROM positioned s
    )
    SELECT ROW_NUMBER() OVER (ORDER BY position, slot, item_order) - 1 AS merge_no, ${FIELDS.join(', ')}
    FROM merged ORDER BY merge_no
  `;
}
