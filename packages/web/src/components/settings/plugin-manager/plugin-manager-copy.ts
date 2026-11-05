const githubSteps = new Map([
  [
    'Log in with the GitHub CLI (`gh auth login`) on the machine running Clowder AI',
    '在运行应用的机器上执行 `gh auth login`，登录 GitHub。',
  ],
  [
    'Optional: configure a token only for plugin-managed child processes that explicitly consume it',
    '可选：为明确需要凭据的插件子进程配置访问令牌。',
  ],
  [
    'Optional: configure Noise Bot list to reduce setup-only comment noise',
    '可选：设置要忽略的机器人账号，减少初始化提示评论。',
  ],
]);
const githubCapabilities = new Map([
  ['cicd-check', '检查 CI/CD 状态'],
  ['conflict-check', '检测分支冲突'],
  ['review-feedback', '接收审查反馈'],
  ['repo-scan', '扫描仓库变更'],
  ['issue-tracking', '跟踪议题'],
]);
const capabilityKinds = new Map([
  ['mcp', 'MCP 工具'],
  ['schedule', '定时任务'],
  ['skill', '技能'],
  ['direct-tool', '工具'],
  ['limb', '外部能力'],
  ['webhook', 'Webhook'],
  ['messaging', '消息'],
  ['events', '事件'],
  ['identity', '身份'],
  ['connector', '连接器'],
  ['service', '服务'],
  ['ui', '界面'],
  ['content-editor-provider', '内容编辑器'],
]);

export function pluginSetupStep(pluginId: string, step: string): string {
  return pluginId === 'github' ? (githubSteps.get(step) ?? step) : step;
}
export function pluginCapabilityName(pluginId: string, name: string): string {
  return pluginId === 'github' ? (githubCapabilities.get(name) ?? name) : name;
}
export function pluginCapabilityKind(kind: string): string {
  return capabilityKinds.get(kind) ?? kind;
}
