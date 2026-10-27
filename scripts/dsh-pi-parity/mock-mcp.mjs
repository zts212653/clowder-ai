import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const [root, server, surface, policy, fixture = 'real'] = process.argv.slice(2);
const all = JSON.parse(readFileSync(join(root, fixture === 'synthetic' ? 'synthetic-schemas.json' : 'schemas.json'), 'utf8'))[server] ?? [];
const selected = new Set(['cat_cafe_read_file_slice', 'cat_cafe_get_thread_context']);
const tools = surface === 'full' ? all : all.filter(tool => selected.has(tool.name));
const roadmap = JSON.parse(readFileSync(join(root, fixture === 'synthetic' ? 'synthetic-roadmap.json' : 'roadmap.json'), 'utf8'));
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server, version: 'parity-readonly-1' } };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params;
    appendFileSync(join(root, 'mock-tool-calls.jsonl'), JSON.stringify({ time: Date.now(), pid: process.pid, server, name, args, policy }) + '\n');
    let text;
    let isError = false;
    if (name === 'cat_cafe_read_file_slice') {
      isError = policy === 'deny';
      const lines = roadmap.split(/\r?\n/);
      text = isError ? `Access denied: ${args.path} is not within allowed directories` : lines.slice(Math.max(0, (args.startLine ?? 1) - 1), (args.startLine ?? 1) - 1 + (args.lineCount ?? 500)).join('\n');
    } else if (name === 'cat_cafe_get_thread_context') text = JSON.stringify({ contextScope: 'diagnostic_fixture', messages: [{ speaker: 'co-creator', content: '读取路线图，给出 #16 与 #14 的现状、建议、验收点。只分析，不实施。' }] });
    else { isError = true; text = 'DIAGNOSTIC_READ_ONLY: this replay records tool intent but does not execute mutations, commands, messages, or external requests.'; }
    result = { content: [{ type: 'text', text }], isError };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
