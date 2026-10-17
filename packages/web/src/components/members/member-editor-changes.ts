import type { CodexRuntimeSettings, HubCatEditorFormState, StrategyFormState } from '../hub-cat-editor.model';
import { membersCopy } from './members.shell-copy';

export type MemberChange = { key: string; label: string; fieldLabels: readonly string[] };
// catId is immutable for an existing member; displayName mirrors name.
type FormKey = Exclude<keyof HubCatEditorFormState, 'catId' | 'displayName'>;
type MemberFieldLabels = readonly [string, string, ...string[]];
const fields: Record<FormKey, MemberFieldLabels> = {
  name: ['名称', 'Name'],
  nickname: ['昵称', 'Nickname'],
  variantLabel: ['显示后缀', 'Variant Label'],
  avatar: ['头像', 'Avatar'],
  colorPrimary: ['消息颜色', 'Message color', 'Background Color'],
  colorSecondary: ['消息颜色', 'Message color', 'Background Color'],
  mentionPatterns: ['@ 名字', 'Mention names', 'Aliases'],
  roleDescription: ['角色描述', 'Description'],
  personality: ['性格特征', 'Personality'],
  teamStrengths: ['擅长领域', 'Team Strengths'],
  caution: ['注意事项', 'Caution'],
  strengths: ['技能标签', 'Strengths'],
  clientId: ['客户端', 'Client'],
  configurationSource: ['配置方式', 'Configuration mode'],
  accountRef: ['账号', 'Account', '用哪个号'],
  accountBindingMode: ['账号', 'Account', '用哪个号'],
  defaultModel: ['模型', 'Model'],
  commandArgs: ['启动参数', 'Launch arguments'],
  cliConfigArgs: ['额外 CLI 参数', 'Extra CLI arguments'],
  cliEffort: ['思考深度', 'Reasoning effort', 'CLI Effort'],
  codexSpeed: ['速度档位', 'Speed tier'],
  carrier: ['接入方式', 'Connection', 'Transport'],
  provider: ['服务商名称', 'Provider name', 'OC Provider Name'],
  agyNativeEnabled: ['启用 Native', 'Enable Native'],
  agyProfileEnabled: ['启用 Native', 'Enable Native'],
  agyAutoApprove: ['执行权限', 'Execution permissions'],
  agyProfileId: ['隔离 Profile ID', 'Isolated Profile ID'],
  agyHomeRoot: ['Profile 根目录', 'Profile root directory'],
  agyTrustedWorkspaces: ['批准工作区', 'Approved workspaces'],
  acpTransport: ['ACP 传输', 'ACP transport'],
  acpCommand: ['ACP 启动命令', 'ACP command', 'ACP Command'],
  acpStartupArgs: ['ACP 启动参数', 'ACP startup arguments', 'ACP Startup Args'],
  acpMaxLiveProcesses: ['最多进程数', 'Maximum processes', 'ACP Max Processes'],
  acpIdleTtlMinutes: ['闲置时限（分钟）', 'Idle timeout (minutes)', 'ACP Idle TTL (min)'],
  mcpSupport: ['Clowder AI 工具', 'Clowder AI tools', 'MCP Support'],
  sessionChain: ['会话链', 'Session chain', 'Session State / Chain'],
  contextWindow: ['上下文窗口', 'Context window', 'Context Window'],
  voiceVoice: ['声音', 'Voice'],
  voiceLangCode: ['语言', 'Language', 'Lang Code'],
  voiceSpeed: ['语速', 'Speed'],
  voiceRefAudio: ['参考音频', 'Reference audio'],
  voiceRefText: ['参考音频文本', 'Reference text', 'Ref Text'],
  voiceInstruct: ['语气说明', 'Voice instructions', 'Instruct'],
  voiceTemperature: ['声音变化', 'Voice variation', 'Temperature'],
};
const strategyFields = {
  strategy: ['会话处理', 'Session handling', 'Session Strategy'],
  warnThreshold: ['提醒线', 'Warning threshold', 'Session Observe Threshold', 'Session Warn Threshold'],
  actionThreshold: [
    '记录线 / 交接线',
    'Action threshold',
    '记录线',
    '交接线',
    'Session Observe Threshold (upper)',
    'Session Action Threshold',
  ],
  maxCompressions: ['最多压缩次数', 'Maximum compressions', 'Max Compressions'],
} satisfies Partial<Record<keyof StrategyFormState, MemberFieldLabels>>;
const configLabels: Record<keyof CodexRuntimeSettings, MemberFieldLabels> = {
  sandboxMode: ['沙箱', 'Sandbox', 'Codex Sandbox (Codex)', 'Codex Sandbox'],
  approvalPolicy: ['审批方式', 'Approval mode', 'Codex Approval (Codex)', 'Codex Approval'],
  authMode: ['认证方式', 'Authentication mode', 'Codex Auth Mode (Codex)', 'Codex Auth Mode'],
};
const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
export function requiredMemberChangeErrors(form: HubCatEditorFormState, changes: readonly MemberChange[]) {
  const errors: Record<string, boolean> = {};
  if (changes.some((change) => change.key === 'name') && !form.name.trim()) errors.Name = true;
  if (changes.some((change) => change.key === 'roleDescription') && !form.roleDescription.trim())
    errors.Description = true;
  return errors;
}
export function memberEditorChanges(
  form: HubCatEditorFormState,
  baseline: HubCatEditorFormState,
  strategy: StrategyFormState | null,
  strategyBaseline: StrategyFormState | null,
  config: CodexRuntimeSettings | null,
  configBaseline: CodexRuntimeSettings | null,
  english: boolean,
): MemberChange[] {
  const changes: MemberChange[] = [];
  const append = (key: string, labels: MemberFieldLabels) => {
    const translated = (english ? membersCopy.en : membersCopy.zh)[labels[0] as keyof typeof membersCopy.zh];
    const label = typeof translated === 'string' ? translated : labels[english ? 1 : 0];
    if (!changes.some((change) => change.label === label)) changes.push({ key, label, fieldLabels: labels });
  };
  for (const key of Object.keys(fields) as FormKey[]) {
    const labels = fields[key];
    if (labels && differs(form[key], baseline[key])) append(key, labels);
  }
  if (strategy && strategyBaseline) {
    for (const key of Object.keys(strategyFields) as (keyof typeof strategyFields)[]) {
      if (differs(strategy[key], strategyBaseline[key])) append(`strategy.${key}`, strategyFields[key]);
    }
  }
  if (config && configBaseline) {
    for (const key of Object.keys(config) as (keyof CodexRuntimeSettings)[]) {
      if (differs(config[key], configBaseline[key])) append(`config.${key}`, configLabels[key]);
    }
  }
  return changes;
}
