import { cleanCliToolLabel } from '@cat-cafe/shared';

/**
 * F322 B — §1.16 合同二: what a cat is doing right now is its latest tool call, said as a verb. Pure: a label and a detail in,
 * a kind and a name out; the words live in `reply-layers.shell-copy.ts`.
 */
export type ToolActionKind = 'run' | 'edit' | 'read' | 'search' | 'web' | 'memory' | 'subagents' | 'other';

export interface ToolAction {
  kind: ToolActionKind;
  /** The tool as the provider named it, MCP server prefix removed. Shown only for a tool this table does not know. */
  tool: string;
  /** Complete provider arguments, available in the hover/focus tip and execution record. */
  detail?: string;
  /** A bounded primary argument proven by the carrier, never a reconstruction of a command. */
  object?: string;
}

const RUN = new Set([
  'bash',
  'shell',
  'command_execution',
  'run_command',
  'exec_command',
  'exec',
  'execute',
  'terminal',
  'local_shell',
]);
const EDIT = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'file_change',
  'apply_patch',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'create_file',
  'update_file',
  'patch',
]);
const READ = new Set(['read', 'view', 'notebookread', 'read_file', 'cat', 'open']);
const SEARCH = new Set(['grep', 'glob', 'search', 'find', 'ls', 'list_dir', 'toolsearch', 'tool_search']);
const WEB = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch', 'browse']);
// The memory tools of this house; their names contain generic words ("search_evidence"), so they are tested first.
const MEMORY = /(search_evidence|graph_resolve|list_recent|read_session|recall|retain_memory|memory)/;

/** `mcp__server__tool` and `mcp:server/tool` both name `tool`. */
function bareToolName(raw: string): string {
  const doubleUnderscore = /^mcp__.+?__(.+)$/.exec(raw);
  if (doubleUnderscore?.[1]) return doubleUnderscore[1];
  const colon = /^mcp:[^/]+\/(.+)$/.exec(raw);
  return (colon?.[1] ?? raw).replace(/^functions\./, '');
}

function kindOf(name: string): ToolActionKind {
  const lower = name.toLowerCase();
  if (['wait_agent', 'collaboration.wait_agent', 'functions.collaboration.wait_agent'].includes(lower))
    return 'subagents';
  if (MEMORY.test(lower)) return 'memory';
  if (RUN.has(lower)) return 'run';
  if (EDIT.has(lower)) return 'edit';
  if (READ.has(lower)) return 'read';
  if (WEB.has(lower)) return 'web';
  if (SEARCH.has(lower)) return 'search';
  return 'other';
}

export function describeToolAction(label: string, detail?: string): ToolAction {
  const first = cleanCliToolLabel(label).trim().split(/\s+/)[0] ?? '';
  const tool = bareToolName(first);
  const kind = kindOf(tool);
  const object = primaryObject(kind, detail);
  return { kind, tool, ...(detail ? { detail } : {}), ...(object ? { object } : {}) };
}

function primaryObject(kind: ToolActionKind, detail: string | undefined): string | undefined {
  if (!detail || detail.length > 65_536 || kind === 'other' || kind === 'subagents') return;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    args = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const string = (...keys: string[]) => keys.map((key) => args[key]).find((value) => typeof value === 'string');
  let value: unknown;
  switch (kind) {
    case 'read':
    case 'edit':
      value = string('file_path', 'path', 'file', 'target_file');
      if (typeof value === 'string') value = value.split(/[\\/]/).at(-1);
      break;
    case 'run': {
      const command = string('command', 'cmd');
      // Only the executable word; options, assignments, scripts and subsequent commands stay in the record.
      value = typeof command === 'string' ? /^\s*([\w./-]+)(?=\s|$)/.exec(command)?.[1]?.split('/').at(-1) : undefined;
      break;
    }
    case 'search':
    case 'memory':
      value = string('query', 'pattern', 'q', 'keyword');
      break;
    case 'web':
      value = string('query', 'q');
      break;
  }
  if (typeof value !== 'string') return;
  const clean = Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : char;
  })
    .join('')
    .trim();
  return clean ? Array.from(clean).slice(0, 48).join('') : undefined;
}
