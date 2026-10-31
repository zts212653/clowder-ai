import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';

const [label, carrier, l0Path, outputDirectory] = process.argv.slice(2);
if (
  !['before', 'after'].includes(label) ||
  !['exec_json', 'app_server'].includes(carrier) ||
  !l0Path ||
  !outputDirectory
) {
  throw new Error(
    'Usage: node f293-codex-token-probe.mjs before|after exec_json|app_server frozen-l0.md output-directory',
  );
}
const prompt = '这是启动 token 对照实验。不要调用任何工具，也不要读取文件。只回复：喵。';
const l0 = readFileSync(l0Path, 'utf8');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120_000);
const service = new CodexAgentService({
  catId: 'codex61-sol',
  model: 'gpt-6.1-sol',
  carrierMode: carrier,
  l0CompilerFn: async () => l0,
});
const result = {
  label,
  carrier,
  catId: 'codex61-sol',
  model: 'gpt-6.1-sol',
  prompt,
  cwd: process.cwd(),
  l0Sha256: createHash('sha256').update(l0).digest('hex'),
  usage: null,
  sessionId: null,
  response: '',
  errors: [],
};
try {
  for await (const event of service.invoke(prompt, {
    workingDirectory: process.cwd(),
    signal: controller.signal,
    callbackEnv: { CODEX_AUTH_MODE: 'oauth' },
  })) {
    if (event.metadata?.usage) result.usage = event.metadata.usage;
    if (event.type === 'session_init') result.sessionId = event.sessionId;
    if (event.type === 'text') result.response += event.content;
    if (event.type === 'error') result.errors.push(event.error);
  }
} finally {
  clearTimeout(timeout);
}
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, `${label}-${carrier}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (!result.usage?.inputTokens || result.errors.length) process.exitCode = 1;
