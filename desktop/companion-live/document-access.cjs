const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

class DocumentAccess {
  constructor({ storage, sourceRoot, hostOrigin }) {
    this.path = resolve(storage, 'document-access.json');
    this.hostOrigin = hostOrigin;
    this.scope = hostOrigin
      ? `household-memory-v2:${hostOrigin}:${resolve(sourceRoot)}`
      : `feature-and-f317-discussion-v1:${resolve(sourceRoot)}`;
    mkdirSync(storage, { recursive: true });
  }
  allowed() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      return value.scope === this.scope && value.recipient === 'codex-chatgpt-astra' && value.allowed === true;
    } catch (error) {
      // operator source 0001789647107278-000020-86b5fec4: the authenticated Host
      // supplies the owner's existing visibility boundary; no second read grant.
      // Preserve explicit opt-out and fail closed for unreadable/corrupt choices.
      return Boolean(this.hostOrigin) && error.code === 'ENOENT';
    }
  }
  async confirm(showDialog, active = false) {
    const before = this.allowed();
    const result = await showDialog({
      type: 'question',
      title: this.hostOrigin ? '资料查询设置' : '砚砚的资料访问',
      message: this.hostOrigin
        ? before
          ? '资料查询已开启'
          : '资料查询已暂停'
        : before
          ? '资料已获准读取'
          : '允许砚砚读取这些资料吗？',
      detail:
        (this.hostOrigin
          ? `沿用当前猫咖登录身份，只能查询这个用户在所连猫咖可见的记忆、对话、文档、人物关系、任务和引导。默认开启，可随时暂停。\n当前连接：${this.hostOrigin}\n接收方：当前 ChatGPT 登录下的 GPT-Live／Astra。传话等行动仍须你的具体要求。\n不包含屏幕、任意电脑操作或替你审批；屏幕仍须主动选择。`
          : '范围：猫咖功能文档与 F317 讨论文档（当前实验版本）。\n接收方：你当前 ChatGPT 登录下的 GPT-Live／Astra，用于查询并语音回答。\n这是只读访问，不包含其他聊天记录、屏幕或写操作。选择会保存，可在这里撤回。') +
        (active ? '\n更改后会重新连接当前语音，保留原生会话坐标和本窗口文字；正在说的这句话会被打断。' : ''),
      buttons: this.hostOrigin
        ? before
          ? ['保持开启', '暂停资料查询']
          : ['恢复资料查询', '保持暂停']
        : before
          ? ['保持开放', '撤回访问']
          : [active ? '允许并重新连接' : '允许读取', '暂不开启'],
      defaultId: before ? 0 : 1,
      cancelId: before ? 0 : 1,
      noLink: true,
    });
    const allowed = before ? result.response !== 1 : result.response === 0;
    if (allowed !== before) {
      const value = {
        scope: this.scope,
        recipient: 'codex-chatgpt-astra',
        allowed,
        source: 'native-dialog',
        at: new Date().toISOString(),
      };
      writeFileSync(`${this.path}.tmp`, JSON.stringify(value), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
    }
    return { allowed, changed: allowed !== before };
  }
}
module.exports = { DocumentAccess };
