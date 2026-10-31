/**
 * F322 B — §1.16 合同二, "正在做哪一步": the last tool call of a turn, said as a verb. The status line reads the tool NAME the
 * provider reported (Claude `Bash`, Codex `command_execution`, a lower-case provider `bash`, an MCP tool under its server
 * prefix) and the primary argument of its detail; a tool this table has never heard of is named, not guessed at.
 */
import { describe, expect, it } from 'vitest';
import { describeToolAction } from '../tool-action';

const kindOf = (label: string, detail?: string) => describeToolAction(label, detail).kind;

describe('describeToolAction', () => {
  it.each([
    ['Bash', 'run'],
    ['bash', 'run'],
    ['command_execution', 'run'],
    ['run_command', 'run'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['file_change', 'edit'],
    ['apply_patch', 'edit'],
    ['Read', 'read'],
    ['read_file', 'read'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['web_search', 'web'],
  ] as const)('%s is %s', (label, kind) => {
    expect(kindOf(label)).toBe(kind);
  });

  it('memory tools win over the generic words inside their names (search_evidence is not "search")', () => {
    expect(kindOf('mcp__cat-cafe-memory__cat_cafe_search_evidence')).toBe('memory');
    expect(kindOf('cat_cafe_graph_resolve')).toBe('memory');
    expect(kindOf('mcp:cat-cafe-memory/cat_cafe_list_recent')).toBe('memory');
  });

  it('strips the MCP server prefix before it names a tool it does not know', () => {
    const action = describeToolAction('mcp__figma__get_design_context');
    expect(action.kind).toBe('other');
    expect(action.tool).toBe('get_design_context');
    expect(describeToolAction('mcp:github/create_pull_request').tool).toBe('create_pull_request');
  });

  it('a tool it has never heard of keeps its own name', () => {
    expect(describeToolAction('FancyNewTool')).toMatchObject({ kind: 'other', tool: 'FancyNewTool' });
  });

  it('takes the tool name from the first word of a label that carries more, and drops a sub-agent prefix', () => {
    expect(describeToolAction('Bash pnpm test').tool).toBe('Bash');
    expect(describeToolAction('Task → Read').kind).toBe('read');
  });

  it('retains the complete argument payload for the tooltip, without CLI-label truncation', () => {
    const detail = JSON.stringify({ command: 'x'.repeat(200), cwd: '/workspace' });
    expect(describeToolAction('Bash', detail).detail).toBe(detail);
    expect(describeToolAction('Edit', JSON.stringify({ file_path: '/a/b.ts', old_string: 'x' })).detail).toContain(
      'old_string',
    );
  });

  it('no detail produces no tooltip payload', () => {
    expect(describeToolAction('Read').detail).toBeUndefined();
    expect(describeToolAction('Read', '').detail).toBeUndefined();
  });

  it.each([
    ['Read', { file_path: '/workspace/ThreadItem.tsx' }, 'ThreadItem.tsx'],
    ['Edit', { file_path: '/workspace/ReplyLastLine.tsx', old_string: 'secret old content' }, 'ReplyLastLine.tsx'],
    ['Grep', { pattern: 'ReplyLastLine', path: '/workspace' }, 'ReplyLastLine'],
    ['Bash', { command: 'pnpm test --token secret\ncat huge-file' }, 'pnpm'],
    ['exec_command', { cmd: 'rg -n ReplyLastLine packages/web' }, 'rg'],
    ['cat_cafe_search_evidence', { query: 'F322 tool feedback' }, 'F322 tool feedback'],
  ])('only exposes the short proven object of %s', (label, args, object) => {
    expect(describeToolAction(label, JSON.stringify(args))).toMatchObject({ object });
  });

  it('missing, malformed and unknown arguments remain category-only, never a guessed object', () => {
    for (const detail of [undefined, '{broken', JSON.stringify({ cwd: '/workspace', token: 'secret' })]) {
      expect(describeToolAction('Read', detail)).not.toHaveProperty('object');
    }
    expect(describeToolAction('FancyNewTool', JSON.stringify({ query: 'not a search' }))).not.toHaveProperty('object');
  });
});
