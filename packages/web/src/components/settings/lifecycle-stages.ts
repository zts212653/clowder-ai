/**
 * F237 — Session lifecycle stage definitions (user-facing).
 *
 * Multi-level nesting matches the actual execution architecture:
 *   Thread → Session(s) → Turn(s) → Client Invoke
 *
 * Key concepts:
 * - nestLevel: which loop a stage belongs to (session / turn / event)
 * - Sub-stages group implementation details within a stage
 * - client-invoke is the preview point (injection content preview)
 * - hook-events are event-driven, separate from the main pipeline
 */

export interface SubStage {
  id: string;
  label: string;
  description: string;
  /** Segment ID prefixes for this sub-stage */
  segmentPrefixes: string[];
}

/**
 * Which loop level a stage belongs to:
 * - session: runs once per session (init/close)
 * - turn: runs each turn within a session
 * - event: event-driven, not in the main pipeline
 */
export type NestLevel = 'session' | 'turn' | 'event';

/** How injection content is delivered to each client */
export interface CarrierInfo {
  /** Injection position: system prompt / per-turn message / event output */
  position: 'system-prompt' | 'message-context' | 'event-output';
  /** Human-readable position label */
  positionLabel: string;
  /** Per-client delivery mechanism */
  clients: readonly { name: string; mechanism: string }[];
}

export interface LifecycleStage {
  id: string;
  label: string;
  description: string;
  /** All segment ID prefixes for this stage (union of sub-stage prefixes) */
  segmentPrefixes: string[];
  /** Implementation-detail grouping within this stage */
  subStages?: SubStage[];
  /** Which nesting level this stage belongs to */
  nestLevel: NestLevel;
  /** Part of the per-turn execution loop */
  isPerTurn: boolean;
  /** Has injection segments */
  hasInjection: boolean;
  /**
   * How far injections persist:
   * - all-turns: set at session init, stable across turns
   * - current-turn: rebuilt each turn
   * - none: no injections (structural or preview point)
   */
  influenceScope: 'all-turns' | 'current-turn' | 'none';
  /** Whether this is the assembled-prompt preview point */
  isPreviewPoint?: boolean;
  /** Whether this runs on external events, not in the main pipeline */
  isEventDriven?: boolean;
  /** How this stage's content is delivered to clients (injection-bearing stages only) */
  carrier?: CarrierInfo;
}

export const LIFECYCLE_STAGES: LifecycleStage[] = [
  {
    id: 'session-start',
    label: '会话创建',
    description: '创建或恢复会话实例。设置会话 ID、模型选择、存储初始化。',
    segmentPrefixes: [],
    nestLevel: 'session',
    isPerTurn: false,
    hasInjection: false,
    influenceScope: 'none',
  },
  {
    id: 'session-init',
    label: '会话初始化',
    description: '基于 L0 模板按猫编译系统提示词，一次注入、整个会话内持久生效，不随回合重复发送。',
    segmentPrefixes: ['L', 'B', 'S'],
    nestLevel: 'session',
    carrier: {
      position: 'system-prompt',
      positionLabel: '系统提示词（会话级，整个会话内持久）',
      clients: [
        { name: 'Claude CLI', mechanism: '--system-prompt-file（native L0，压缩免疫）' },
        { name: 'Codex CLI', mechanism: 'developer_instructions 配置字段' },
        { name: 'OpenCode', mechanism: 'instructions 配置文件' },
        { name: 'Gemini / Kimi / Others', mechanism: '首条消息 body 前置拼接（新会话/压缩后重注入，非每轮）' },
      ],
    },
    subStages: [
      {
        id: 'l0-compile',
        label: 'L0 系统提示词',
        description: '系统提示词模板编译注入。包含身份规则、协作协议、安全铁律等。整个会话内不变。',
        segmentPrefixes: ['L'],
      },
      {
        id: 'bootstrap',
        label: '会话引导',
        description: '第 2+ 次会话的上下文续接信息，帮助模型理解之前的状态。',
        segmentPrefixes: ['B'],
      },
      {
        id: 'static-identity',
        label: '静态身份',
        description: '身份声明、队友名册、工作流配置等。每会话初始化一次。',
        segmentPrefixes: ['S'],
      },
    ],
    isPerTurn: false,
    hasInjection: true,
    influenceScope: 'all-turns',
  },
  {
    id: 'turn-build',
    label: '回合构建',
    description: '每回合动态注入：路由、上下文、客户端指令、导航。修改这里的内容在当前回合立即生效。',
    segmentPrefixes: ['R', 'D', 'M', 'C', 'N'],
    nestLevel: 'turn',
    carrier: {
      position: 'message-context',
      positionLabel: '消息上下文（每轮重建，拼入用户消息前）',
      clients: [{ name: '所有客户端', mechanism: '用户消息 body 前置拼接（prompt prefix）' }],
    },
    subStages: [
      {
        id: 'route',
        label: '路由组装',
        description: '根据串行/并行/独立模式选择 prompt 前缀，支持按猫覆盖。',
        segmentPrefixes: ['R'],
      },
      {
        id: 'context',
        label: '上下文构建',
        description: '动态调用上下文。球权、队友状态、模式标记、功能上下文等。',
        segmentPrefixes: ['D'],
      },
      {
        id: 'mutations',
        label: '客户端指令',
        description: '调用时追加：外部项目分派、转录路径、MCP HTTP 回退。',
        segmentPrefixes: ['M', 'C'],
      },
      {
        id: 'navigation',
        label: '导航注入',
        description: '传球路径导航块和对话历史增量。',
        segmentPrefixes: ['N'],
      },
    ],
    isPerTurn: true,
    hasInjection: true,
    influenceScope: 'current-turn',
  },
  {
    id: 'client-invoke',
    label: '客户端调用',
    description: '系统提示词 + 每轮动态内容组装完毕，通过对应客户端（Claude CLI / Codex CLI / Gemini API）发送给模型。',
    segmentPrefixes: [],
    nestLevel: 'turn',
    isPerTurn: true,
    hasInjection: false,
    influenceScope: 'none',
    isPreviewPoint: true,
  },
  {
    id: 'turn-close',
    label: '回合结束',
    description: '响应流式返回，处理传球和状态更新。如有后续回合则循环回回合构建。',
    segmentPrefixes: [],
    nestLevel: 'turn',
    isPerTurn: true,
    hasInjection: false,
    influenceScope: 'none',
  },
  {
    id: 'session-close',
    label: '会话结束',
    description: '会话封存（上下文溢出/压缩/CLI 重启时触发）。归档记录后，下次调用创建新会话。',
    segmentPrefixes: [],
    nestLevel: 'session',
    isPerTurn: false,
    hasInjection: false,
    influenceScope: 'none',
  },
  {
    id: 'hook-events',
    label: 'Hook 事件',
    description: '外部 shell hook 输出。启动、压缩、停止时触发。事件驱动，独立于主管线。',
    segmentPrefixes: ['H'],
    nestLevel: 'event',
    isPerTurn: false,
    hasInjection: true,
    carrier: {
      position: 'event-output',
      positionLabel: '事件输出（hook stdout → system-reminder 注入）',
      clients: [
        { name: 'Claude CLI', mechanism: 'hook stdout → <system-reminder> 注入对话' },
        { name: 'Codex CLI', mechanism: 'hook stdout → system_info 输出' },
        { name: 'Others', mechanism: '不支持 hook 机制' },
      ],
    },
    influenceScope: 'current-turn',
    isEventDriven: true,
  },
];

/** Pipeline stages (excluding event-driven) in execution order */
export const PIPELINE_STAGES = LIFECYCLE_STAGES.filter((s) => !s.isEventDriven);

/** Event-driven stages (separate from main pipeline) */
export const EVENT_STAGES = LIFECYCLE_STAGES.filter((s) => s.isEventDriven);

/** Map segment ID to lifecycle stage by first-character prefix */
export function getStageForSegment(segmentId: string): string | null {
  const prefix = segmentId.charAt(0);
  return LIFECYCLE_STAGES.find((s) => s.segmentPrefixes.includes(prefix))?.id ?? null;
}

/** Map segment ID to sub-stage within its parent stage */
export function getSubStageForSegment(segmentId: string): string | null {
  const prefix = segmentId.charAt(0);
  for (const stage of LIFECYCLE_STAGES) {
    if (!stage.subStages) continue;
    const sub = stage.subStages.find((ss) => ss.segmentPrefixes.includes(prefix));
    if (sub) return sub.id;
  }
  return null;
}

const SCOPE_LABELS: Record<string, string> = {
  'all-turns': '所有回合',
  'current-turn': '当前回合',
  none: '—',
};

export { SCOPE_LABELS };

/** Subsequent pipeline stage IDs after `stageId`, optionally limited to per-turn */
function pipelineAfter(stageId: string, perTurnOnly: boolean): string[] {
  const idx = PIPELINE_STAGES.findIndex((s) => s.id === stageId);
  const rest: string[] = [];
  for (let i = idx + 1; i < PIPELINE_STAGES.length; i++) {
    const s = PIPELINE_STAGES[i];
    if (perTurnOnly && !s.isPerTurn) break;
    rest.push(s.id);
  }
  return rest;
}

/**
 * Compute which stages fall in the influence range of the selected stage.
 * Returns a Set of stage IDs for light-green background rendering.
 */
export function computeInfluenceSet(selectedStageId: string | null): Set<string> {
  if (!selectedStageId) return new Set();
  const stage = LIFECYCLE_STAGES.find((s) => s.id === selectedStageId);
  if (!stage || stage.influenceScope === 'none') return new Set();

  // Event-driven current-turn: only client-invoke
  if (stage.isEventDriven) return new Set(['client-invoke']);

  const ids = pipelineAfter(selectedStageId, stage.influenceScope === 'current-turn');
  const result = new Set(ids);

  // Session-scoped also influences event-driven stages
  if (stage.influenceScope === 'all-turns') {
    for (const ev of EVENT_STAGES) result.add(ev.id);
  }
  return result;
}
