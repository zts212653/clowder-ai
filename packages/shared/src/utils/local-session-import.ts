export const LOCAL_SESSION_IMPORT_TOOLS = [
  { clientId: 'anthropic', label: 'Claude Code', recentSessions: true },
  { clientId: 'openai', label: 'Codex', recentSessions: true },
  { clientId: 'opencode', label: 'OpenCode', recentSessions: true },
] as const;

export type LocalSessionClientId = (typeof LOCAL_SESSION_IMPORT_TOOLS)[number]['clientId'];

/** Internal bounded candidate window, before origin/claim filtering and the public 20-row limit. */
export const LOCAL_SESSION_CANDIDATE_LIMIT = 200;

/** Origin evidence is independent of whether a readable human title can be extracted. */
export function isCatCafeSessionInput(value: string): boolean {
  let text = value.slice(0, 2000).trim();
  // These plugin envelopes precede the original input. Only skip complete known
  // blocks; an unknown/clipped preamble is not evidence of Cafe ownership.
  const plugins = [
    /^\[search-mode\]\s*MAXIMIZE SEARCH EFFORT\.[\s\S]*?NEVER stop at first result - be exhaustive\./,
    /^\[analyze-mode\]\s*ANALYSIS MODE\.[\s\S]*?SYNTHESIZE findings before proceeding\./,
    /^MANDATORY delegate_task params:[^\n]*\nExample: delegate_task\([^\n]*\)/,
  ];
  let skippedPlugin = false;
  for (const plugin of plugins) {
    const block = plugin.exec(text);
    if (block) {
      skippedPlugin = true;
      text = text
        .slice(block[0].length)
        .trim()
        .replace(/^---\s*\n\s*/, '');
    }
  }
  if (skippedPlugin) text = text.replace(/^["']/, '');
  if (/^["']?你是 [^\r\n（）]{1,80}（[^\r\n（）]{1,80}），由 opencode 提供的 AI 猫猫(?:[。.!！]|\r?\n|$)/.test(text))
    return true;
  return /^(?:<runtime-routing-context>|>\s*L0 Staging Layer\b|Identity:|\[Context Continuity\])/.test(text);
}

export function localSessionImportTool(member: { clientId: string; id?: string; provider?: string; cli?: unknown }) {
  if (!member.cli || member.id === 'gpt-pro' || member.provider === 'openai-chatgpt-pro') return undefined;
  return LOCAL_SESSION_IMPORT_TOOLS.find((tool) => tool.clientId === member.clientId);
}

export function isLocalSessionId(clientId: string, value: string): boolean {
  return clientId === 'opencode'
    ? /^ses_[A-Za-z0-9]{1,196}$/.test(value)
    : ['openai', 'anthropic'].includes(clientId) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Only strip recognized leading envelopes. A clipped index is not evidence of a human request. */
export function humanSessionFirstLine(value: string): string {
  let text = value.trim();
  for (let pass = 0; pass < 6; pass++) {
    const wrapper = /^<(runtime-routing-context|environment_context|system_instructions|user_instructions)>/.exec(text);
    if (wrapper) {
      const end = text.indexOf(`</${wrapper[1]}>`);
      if (end < 0) return '';
      text = text
        .slice(end + wrapper[1].length + 3)
        .trim()
        .replace(/^---\s*/, '');
      continue;
    }
    if (/^# Files mentioned by the user:/i.test(text)) {
      const request = /(?:^|\n)## (?:My request(?: for Codex)?|User request):\s*\n/.exec(text);
      if (!request) return '';
      text = text.slice(request.index + request[0].length).trim();
      continue;
    }
    if (
      /^(?:>\s*L0 Staging Layer|Identity:|\[Context Continuity\]|\[(?:search|analyze)-mode\]|# AGENTS\.md instructions|<realtime_delegation>|<user_request>\s*$)/.test(
        text,
      )
    )
      return '';
    return text.split('\n', 1)[0].trim().slice(0, 500);
  }
  return '';
}
