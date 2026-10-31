/** Controlled native frames; not a captured model run. Uses the production mapper unchanged. */
export function subexecutionReadbackFrames() {
  const base = {
    type: 'app_server.subexecution',
    root_execution_id: 'native-readback',
    root_turn_id: 'native-turn',
    parent_execution_id: 'native-readback',
    parent_turn_id: 'native-turn',
    depth: 1,
  };
  const frame = (id, child, task, name, patch = {}) => ({
    ...base,
    event_id: id,
    occurred_at: 1000,
    stage: 'started',
    subexecution_id: child,
    agent_path: `/root/${task}`,
    nickname: name,
    ...patch,
  });
  const schema = (id, patch) => frame(id, 'child-schema', 'video_schema', 'Hooke', patch);
  const review = (id, patch) => frame(id, 'child-reviews', 'project_reviews', 'Galileo', patch);
  return [
    schema('schema-start', {}),
    schema('schema-progress', {
      stage: 'message',
      turn_id: 'schema-turn',
      message_phase: 'commentary',
      content: '核对字段原合同。',
      occurred_at: 2000,
    }),
    schema('schema-final', {
      stage: 'message',
      turn_id: 'schema-turn',
      message_phase: 'final_answer',
      content: '子代理字段核对完成。',
      occurred_at: 241000,
    }),
    schema('schema-done', { stage: 'completed', turn_id: 'schema-turn', occurred_at: 241010 }),
    review('review-start', {}),
    ...Array.from({ length: 11 }, (_, i) =>
      review(`review-progress-${i}`, {
        stage: 'message',
        turn_id: 'review-turn',
        message_phase: 'commentary',
        content: `子代理原进展 ${i + 1}。`,
        occurred_at: 1000 + (i + 1) * 9000,
      }),
    ),
    frame('nested-start', 'child-bounds', 'video_schema/bbox_bounds', 'Halley', {
      parent_execution_id: 'child-schema',
      parent_turn_id: 'schema-turn',
      depth: 2,
    }),
    frame('nested-done', 'child-bounds', 'video_schema/bbox_bounds', 'Halley', {
      parent_execution_id: 'child-schema',
      parent_turn_id: 'schema-turn',
      depth: 2,
      stage: 'completed',
      turn_id: 'bounds-turn',
      occurred_at: 61000,
    }),
    frame('asset-failed', 'child-assets', 'assets_index', 'Curie', { stage: 'failed', turn_id: 'asset-turn' }),
    frame('export-interrupted', 'child-export', 'export_jobs', 'Kepler', {
      stage: 'interrupted',
      turn_id: 'export-turn',
    }),
    frame(
      'unknown-report',
      'child-unknown',
      'long_task_identifier_'.repeat(5),
      'A long native name that must stay contained',
      {
        stage: 'message',
        turn_id: 'unknown-turn',
        message_phase: 'unknown',
        content: '该条原消息阶段未知。',
      },
    ),
  ];
}
