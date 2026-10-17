import { type HubCatEditorFormState, initialState } from '../../hub-cat-editor.model';
import type { MemberText } from './MemberRuntimeFields';
import type { MemberDraft } from './member-editor-state';

const labels: Record<keyof HubCatEditorFormState, [string, string]> = {
  accountBindingMode: ['账号跟随方式', 'Account binding mode'],
  agyNativeEnabled: ['Antigravity 原生运行', 'Native Antigravity'],
  agyAutoApprove: ['Antigravity 自动审批', 'Antigravity automatic approval'],
  agyProfileEnabled: ['Antigravity 配置档', 'Antigravity profile'],
  agyProfileId: ['Antigravity 配置档 ID', 'Antigravity profile ID'],
  agyHomeRoot: ['Antigravity 用户目录', 'Antigravity home directory'],
  agyTrustedWorkspaces: ['Antigravity 可信目录', 'Antigravity trusted workspaces'],
  catId: ['成员标识', 'Member ID'],
  name: ['名字', 'Name'],
  displayName: ['显示名称', 'Display name'],
  nickname: ['昵称', 'Nickname'],
  variantLabel: ['版本名称', 'Variant'],
  avatar: ['头像', 'Avatar'],
  colorPrimary: ['主色', 'Primary color'],
  colorSecondary: ['辅助色', 'Secondary color'],
  mentionPatterns: ['呼叫别名', 'Aliases'],
  roleDescription: ['职责', 'Role'],
  personality: ['性格', 'Personality'],
  teamStrengths: ['团队特长', 'Team strengths'],
  caution: ['注意事项', 'Caution'],
  strengths: ['能力标签', 'Strengths'],
  clientId: ['使用工具', 'Tool'],
  configurationSource: ['默认值来源', 'Default source'],
  accountRef: ['使用连接', 'Connection'],
  defaultModel: ['模型', 'Model'],
  cliEffort: ['思考强度', 'Reasoning effort'],
  cliConfigArgs: ['额外启动参数', 'Extra arguments'],
  commandArgs: ['启动参数', 'Launch arguments'],
  codexSpeed: ['Codex 速度', 'Codex speed'],
  carrier: ['接入方式', 'Carrier'],
  provider: ['供应商', 'Provider'],
  mcpSupport: ['MCP 工具', 'MCP tools'],
  acpTransport: ['ACP 传输', 'ACP transport'],
  acpCommand: ['ACP 程序', 'ACP command'],
  acpStartupArgs: ['ACP 启动参数', 'ACP arguments'],
  acpMaxLiveProcesses: ['ACP 进程上限', 'ACP process limit'],
  acpIdleTtlMinutes: ['ACP 空闲回收', 'ACP idle timeout'],
  sessionChain: ['会话延续', 'Session continuity'],
  contextWindow: ['上下文上限', 'Context window'],
  voiceVoice: ['音色', 'Voice'],
  voiceLangCode: ['语音语言', 'Voice language'],
  voiceSpeed: ['语速', 'Voice speed'],
  voiceRefAudio: ['参考音频', 'Reference audio'],
  voiceRefText: ['参考文本', 'Reference text'],
  voiceInstruct: ['语音指令', 'Voice instruction'],
  voiceTemperature: ['语音随机性', 'Voice temperature'],
};

function display(key: keyof HubCatEditorFormState, value: unknown, t: MemberText): string {
  if (key === 'clientId')
    return ({ openai: 'Codex', anthropic: 'Claude Code' } as Record<string, string>)[String(value)] ?? String(value);
  if (key === 'carrier' && value === 'app_server') return 'App Server';
  if (key === 'configurationSource')
    return value === 'native_tool' ? t('工具配置', 'Tool settings') : t('已有连接配置', 'Existing connection');
  if (typeof value === 'boolean') return value ? t('开启', 'On') : t('关闭', 'Off');
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0))
    return t('未指定 / 跟随默认', 'Default');
  // Arguments may contain credentials; the summary describes their change without echoing them.
  if (/Args$/.test(key)) return t('已设置（高级接入中查看）', 'Configured (see Advanced connection)');
  return String(value);
}

export function MemberChangeSummary({ draft, count, t }: { draft: MemberDraft; count: number; t: MemberText }) {
  const original = initialState(draft.baseline);
  const changed = (Object.keys(draft.form) as (keyof HubCatEditorFormState)[]).filter(
    (key) => JSON.stringify(draft.form[key]) !== JSON.stringify(original[key]),
  );
  return (
    <details className="min-w-0 flex-1 text-sm">
      <summary className="cursor-pointer py-2">
        {t(`${count} 处修改未保存 · 查看修改`, `${count} unsaved changes · View changes`)}
      </summary>
      <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto" aria-label={t('待保存的修改', 'Pending changes')}>
        {changed.map((key) => (
          <li key={key} className="break-words">
            <span className="font-medium">{labels[key] ? t(...labels[key]) : key}</span>：
            <span className="text-cafe-secondary">{display(key, original[key], t)}</span> →{' '}
            {display(key, draft.form[key], t)}
          </li>
        ))}
        {JSON.stringify(draft.strategy) !== JSON.stringify(draft.strategyBaseline) && (
          <li>{t('上下文与会话策略', 'Context & session strategy')}</li>
        )}
        {JSON.stringify(draft.codexSettings) !== JSON.stringify(draft.codexBaseline) && (
          <li>{t('全局 Codex 运行参数（高级接入）', 'Global Codex settings (Advanced connection)')}</li>
        )}
      </ul>
    </details>
  );
}
