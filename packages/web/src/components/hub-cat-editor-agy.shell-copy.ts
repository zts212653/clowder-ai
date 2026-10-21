import { defineShellCopy } from './shell/shell-copy';

export const agyNativeCopy = defineShellCopy({
  zh: {
    acpEnabled: '启用 ACP',
    acpLogin: '使用此 Profile 内 ACP 独立登录的个人订阅。旧 Native 身份和历史保留；保存不会调用模型。',
    acpRestricted: '可读取文件并调用获准的 MCP 工具；文件写入和命令会被拒绝。需要这些操作时请选择自动批准。',
    acpBinding: '设置变更后会重新核验会话；无法续接时需手动新建会话，已有历史保留。',
    acpQueue: '活动回合中的新消息沿队列接收；不支持精确插入当前生成。',
    acpSetup: '首次登录：在仓库根目录运行以下命令，按浏览器指引完成个人订阅授权。',
    permission: '执行权限',
    restricted: '受限模式',
    automatic: '自动批准（危险模式）',
    automaticDescription: '自动批准文件与命令操作，可访问工作区外的文件；系统保护范围和只读限制仍然有效。',
    restrictedDescription:
      '在批准的工作区内启用原生沙箱，可读取文件并调用获准的 MCP 工具。文件写入和所有命令（含只读命令）会被直接拒绝；如需这些操作，请选择自动批准。',
    bindingChange: '设置变更后会重新核验会话；无法续接时新建会话，已有历史消息保留。',
  },
  en: {
    acpEnabled: 'Enable ACP',
    acpLogin:
      'Use the personal subscription signed in separately for ACP in this Profile. Existing Native identity and history are kept. Saving does not call a model.',
    acpRestricted:
      'Can read files and call permitted MCP tools. File writes and commands are denied. Choose auto-approve to enable them.',
    acpBinding:
      'Settings changes recheck the session. Start a new session explicitly if it is incompatible; existing history is kept.',
    acpQueue:
      'New messages during an active turn use the queue. Precise insertion into the current generation is unsupported.',
    acpSetup:
      'First sign-in: run this command from the repository root and complete personal subscription authorization in the browser.',
    permission: 'Execution permissions',
    restricted: 'Restricted',
    automatic: 'Auto-approve (dangerous)',
    automaticDescription:
      'Automatically approves file and command operations, including access outside the workspace. System protections and read-only restrictions still apply.',
    restrictedDescription:
      'Uses the native sandbox in approved workspaces. Can read files and call permitted MCP tools. File writes and all shell commands, including read-only commands, are denied outright. Choose auto-approve to enable these operations.',
    bindingChange:
      'Setting changes recheck session compatibility. A new session starts when needed; existing messages are kept.',
  },
});
