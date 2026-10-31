import type { ProviderSubexecutionSemanticEvent as Event } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

const time = Date.UTC(2026, 9, 8, 6);
function child(id: string, overrides: Partial<Event>): Event {
  return {
    v: 1,
    kind: 'subexecution',
    id,
    occurredAt: time,
    stage: 'started',
    subexecutionId: 'child-schema',
    rootExecutionId: 'root-demo',
    parentExecutionId: 'root-demo',
    rootTurnId: 'root-demo-turn',
    parentTurnId: 'root-demo-turn',
    agentPath: '/root/video_schema',
    nickname: 'Hooke',
    depth: 1,
    provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' },
    ...overrides,
  };
}

export function subexecutionSceneMessages(): ChatMessage[] {
  const events: Event[] = [
    child('schema-start', {}),
    child('schema-old', {
      stage: 'message',
      turnId: 'schema-turn',
      messagePhase: 'commentary',
      occurredAt: time + 1000,
      content: '核对任务标识与已有数据合同。',
    }),
    child('schema-final', {
      stage: 'message',
      turnId: 'schema-turn',
      messagePhase: 'final_answer',
      occurredAt: time + 240000,
      content: '字段核对完成；原文本和身份均保留。',
    }),
    child('schema-done', { stage: 'completed', turnId: 'schema-turn', occurredAt: time + 240010 }),
    child('nested-start', {
      subexecutionId: 'child-bounds',
      parentExecutionId: 'child-schema',
      parentTurnId: 'schema-turn',
      agentPath: '/root/video_schema/bbox_bounds',
      nickname: 'Halley',
      depth: 2,
    }),
    child('nested-done', {
      subexecutionId: 'child-bounds',
      parentExecutionId: 'child-schema',
      parentTurnId: 'schema-turn',
      agentPath: '/root/video_schema/bbox_bounds',
      nickname: 'Halley',
      depth: 2,
      stage: 'completed',
      turnId: 'bounds-turn',
      occurredAt: time + 60000,
    }),
    child('review-start', { subexecutionId: 'child-reviews', agentPath: '/root/project_reviews', nickname: 'Galileo' }),
    ...Array.from({ length: 10 }, (_, index) =>
      child(`review-update-${index}`, {
        subexecutionId: 'child-reviews',
        agentPath: '/root/project_reviews',
        nickname: 'Galileo',
        stage: 'message',
        turnId: 'review-turn',
        messagePhase: 'commentary',
        occurredAt: time + (index + 1) * 9000,
        content: `已记录进展 ${index + 1}：保留原有父子身份与原始文字。`,
      }),
    ),
    child('failed', {
      subexecutionId: 'child-assets',
      agentPath: '/root/assets_index',
      nickname: 'Curie',
      stage: 'failed',
      turnId: 'assets-turn',
    }),
    child('interrupted', {
      subexecutionId: 'child-export',
      agentPath: '/root/export_jobs',
      nickname: 'Kepler',
      stage: 'interrupted',
      turnId: 'export-turn',
    }),
    child('unknown-message', {
      subexecutionId: 'child-unknown',
      agentPath: `/root/${'long_task_identifier_'.repeat(5)}`,
      nickname: 'A very long native nickname that must remain readable through its title',
      stage: 'message',
      turnId: 'unknown-turn',
      messagePhase: 'unknown',
      content: '这条原消息没有确认的阶段，不称为最终回报。',
    }),
  ];
  return [
    {
      from: { kind: 'agent', catId: 'codex' },
      id: 'subagent-working',
      type: 'assistant',
      catId: 'codex',
      timestamp: time,
      content: '我先核对现有数据，进展收在执行记录里。',
      isStreaming: true,
      toolEvents: [
        {
          id: 'parent-search',
          type: 'tool_use',
          label: 'Grep',
          detail: 'private arguments stay in the parent record',
          timestamp: time,
        },
      ],
      metadata: {
        provider: 'openai',
        model: 'gpt-6.1-sol',
        subexecutionEvents: [...events].reverse().concat(events.slice(0, 1)),
      },
    },
    {
      from: { kind: 'agent', catId: 'codex' },
      id: 'subagent-completed',
      type: 'assistant',
      catId: 'codex',
      timestamp: time + 260000,
      content: '核对完成，记录在下面；回答仍由母猫整理。',
      metadata: {
        provider: 'openai',
        model: 'gpt-6.1-sol',
        subexecutionEvents: events.filter((event) => event.subexecutionId === 'child-schema'),
      },
    },
  ];
}
