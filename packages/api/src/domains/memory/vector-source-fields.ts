/** Parent policy affects admission; changing a directory summary does not re-encode its messages. */
export const PASSAGE_PARENT_POLICY_FIELDS = [
  'anchor',
  'kind',
  'status',
  'source_path',
  'pack_id',
  'collection_id',
  'review_status',
  'world_id',
  'scene_id',
  'activation',
  'provenance_tier',
  'provenance_source',
  'generalizable',
] as const;

/** Index membership only; final owner/source authority remains in the ordinary reader. */
export const ELIGIBLE_VECTOR_PASSAGE = `EXISTS(SELECT 1 FROM evidence_docs d WHERE d.anchor=p.doc_anchor)
  AND NOT EXISTS(SELECT 1 FROM message_recall_index_suppressions s WHERE s.doc_anchor=p.doc_anchor AND s.passage_id=p.passage_id)`;
