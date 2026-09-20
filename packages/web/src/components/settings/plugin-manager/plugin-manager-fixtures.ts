import type {
  PluginDescription,
  PluginIconSpec,
  PluginManagerActions,
  PluginManagerArtifactState,
  PluginManagerAuthState,
  PluginManagerConfigState,
  PluginManagerContribution,
  PluginManagerContributionTool,
  PluginManagerDetail,
  PluginManagerIntentState,
  PluginManagerLiveState,
} from '@cat-cafe/shared';

export type PluginManagerReadmeState =
  | { readonly state: 'loading' }
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'available'; readonly markdown: string };

export interface PluginManagerDesignFixture {
  id: string;
  displayName: string;
  description: PluginDescription;
  icon: PluginIconSpec;
  iconBg?: string;
  publisher: string;
  packageName: string;
  source: 'catalog' | 'local';
  trust: 'official' | 'local-trusted';
  sourceAdapter?: 'repository-local' | 'connector';
  availableVersion: string;
  installedVersion: string | null;
  artifact: PluginManagerArtifactState;
  config: PluginManagerConfigState;
  auth: PluginManagerAuthState;
  intent: PluginManagerIntentState;
  live: PluginManagerLiveState;
  capabilities: Array<{ name: string; description: string }>;
  contributions?: PluginManagerContribution[];
  tools?: Array<Pick<PluginManagerContributionTool, 'contributionId' | 'name' | 'description'>>;
  readme: PluginManagerReadmeState;
  setupSteps?: string[];
  docsUrl?: string;
  configFields?: PluginManagerDetail['configFields'];
  diagnostic?: string;
  actions?: PluginManagerActions;
}

export const PLUGIN_MANAGER_DESIGN_FIXTURES: readonly PluginManagerDesignFixture[] = [
  {
    id: 'github',
    displayName: 'GitHub',
    description: {
      default: 'GitHub PR tracking, CI/CD monitoring, conflict detection, and repository scanning.',
      translations: { 'zh-CN': '跟踪 PR、CI/CD、冲突检测与仓库扫描，让 Agent 和用户看到同一份仓库协作能力。' },
    },
    icon: 'github',
    iconBg: '#24292e',
    publisher: 'Clowder AI',
    packageName: '@clowder-ai/github',
    source: 'local',
    trust: 'local-trusted',
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    artifact: 'installed',
    config: 'ready',
    auth: 'connected',
    intent: 'enabled',
    live: 'running',
    readme: { state: 'absent' },
    setupSteps: [
      '在运行 Clowder AI 的机器上使用 GitHub CLI 登录',
      '可选：仅为显式消费凭据的插件子进程配置 token',
      '可选：配置 Noise Bot 列表以减少初始化评论噪音',
    ],
    docsUrl: 'https://cli.github.com/manual/gh_auth_login',
    configFields: [
      {
        kind: 'secret',
        key: 'GITHUB_TOKEN',
        label: 'Personal Access Token',
        required: false,
        currentValue: '••••••',
        sensitive: true,
      },
      {
        kind: 'list',
        key: 'GITHUB_NOISE_BOTS',
        label: 'Noise Bot Login List',
        required: false,
        currentValue: null,
        sensitive: false,
      },
      {
        kind: 'secret',
        key: 'GITHUB_MCP_TOKEN',
        label: 'MCP Token',
        required: false,
        currentValue: null,
        sensitive: true,
      },
    ],
    capabilities: [
      { name: 'cicd-check', description: '检查 CI/CD 状态' },
      { name: 'conflict-check', description: '检测分支冲突' },
      { name: 'review-feedback', description: '投递 review 反馈' },
      { name: 'repo-scan', description: '扫描仓库变更' },
      { name: 'issue-tracking', description: '跟踪 issue 评论与状态' },
    ],
  },
  {
    id: 'feishu-meeting-intake',
    displayName: '飞书会议纪要同步',
    description: {
      default: 'Receive generated Feishu meeting notes and transcripts for Agent-assisted organization.',
      translations: { 'zh-CN': '自动接收飞书生成的智能纪要和文字稿，交给猫猫整理。' },
    },
    icon: { type: 'png', src: '/images/connectors/feishu.png' },
    iconBg: '#3370ff',
    publisher: 'Clowder AI',
    packageName: '@clowder-ai/feishu-meeting-intake',
    source: 'catalog',
    trust: 'official',
    availableVersion: '0.1.0-alpha.8',
    installedVersion: '0.1.0-alpha.8',
    artifact: 'installed',
    config: 'ready',
    auth: 'connected',
    intent: 'enabled',
    live: 'running',
    readme: { state: 'absent' },
    capabilities: [
      { name: '事件输入', description: '发布已声明的飞书会议纪要信号' },
      { name: '消息', description: '把纪要投递给已授权的会话' },
    ],
    contributions: [
      {
        id: 'meeting-events',
        kind: 'events',
        name: '事件输入',
        description: '发布已声明的飞书会议纪要信号',
      },
      {
        id: 'meeting-messages',
        kind: 'messaging',
        name: '消息',
        description: '把纪要投递给已授权的会话',
      },
    ],
  },
  {
    id: 'video-analysis',
    displayName: '视频分析',
    description: {
      default: 'Analyze remote videos through configured Gemini or Zhipu providers.',
      translations: { 'zh-CN': '通过已配置的 Gemini 或智谱视觉模型分析远程视频。' },
    },
    // Exact package asset copied only into the explicit Design Gate fixture.
    // Production receives a Host-rewritten URL after package verification.
    icon: { type: 'svg', src: '/images/plugin-fixtures/video-analysis.svg' },
    publisher: 'Clowder AI',
    packageName: '@clowder-ai/video-analysis',
    source: 'catalog',
    trust: 'official',
    availableVersion: '0.1.0-alpha.0',
    installedVersion: null,
    artifact: 'absent',
    config: 'incomplete',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    readme: { state: 'absent' },
    capabilities: [
      { name: 'MCP tool', description: '按需分析视频并返回结构化结果' },
      { name: '媒体读取', description: '只读取用户显式选择的视频' },
    ],
  },
  {
    id: 'wechat-visible-reader',
    displayName: '微信读屏',
    description: {
      default: 'Read the currently visible WeChat window during a bounded user authorization.',
      translations: { 'zh-CN': '在用户短时授权后读取当前可见的微信窗口。' },
    },
    icon: { type: 'png', src: '/images/connectors/weixin.png' },
    iconBg: '#07c160',
    publisher: 'Clowder AI',
    packageName: '@clowder-ai/wechat-visible-reader',
    source: 'local',
    trust: 'local-trusted',
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    artifact: 'installed',
    config: 'invalid',
    auth: 'expired',
    intent: 'disabled',
    live: 'stopped',
    readme: { state: 'absent' },
    capabilities: [{ name: '屏幕观察', description: '在有界授权窗口内采集当前可见内容' }],
    diagnostic: '短时授权已过期；重新授权前不会采集屏幕。',
  },
  {
    id: 'video-gen',
    displayName: '本地视频生成',
    description: {
      default: 'Generate short videos with a local model and report progress back to the conversation.',
      translations: { 'zh-CN': '通过本地模型生成短视频，并把进度回写到会话。' },
    },
    icon: 'video',
    iconBg: '#6366f1',
    publisher: 'Clowder AI',
    packageName: '@clowder-ai/video-gen',
    source: 'catalog',
    trust: 'official',
    availableVersion: '0.1.0-alpha.1',
    installedVersion: '0.1.0-alpha.1',
    artifact: 'installed',
    config: 'ready',
    auth: 'not-required',
    intent: 'enabled',
    live: 'crashed',
    readme: { state: 'absent' },
    capabilities: [
      { name: 'MCP tool', description: '提交视频生成任务' },
      { name: '服务', description: '管理本地生成进程与结果文件' },
    ],
    diagnostic: '运行进程已退出；可以先停用，再重新启用。',
  },
  {
    id: 'personal-chrome-host',
    displayName: 'Personal Chrome',
    description: {
      default: 'Connect an explicitly authorized personal browser session to Clowder AI.',
      translations: { 'zh-CN': '把明确授权的浏览器会话连接到 Clowder AI。' },
    },
    icon: 'chrome',
    iconBg: '#4285f4',
    publisher: 'Local Host',
    packageName: 'personal-chrome-host',
    source: 'local',
    trust: 'local-trusted',
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    artifact: 'installed',
    config: 'ready',
    auth: 'disconnected',
    intent: 'disabled',
    live: 'stopped',
    readme: { state: 'absent' },
    capabilities: [{ name: '会话投递', description: '向已绑定的浏览器会话追加消息' }],
  },
];
