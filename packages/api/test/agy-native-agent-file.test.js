import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { materializeAgyNativeAgentFile } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js'
);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-agent-file-'));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('F325 native L0 agent artifact', () => {
  test('writes the compiled L0 to one isolated profile with stable content fingerprint', () => {
    const f = fixture();
    try {
      const body = '# Identity\nYou are F325-TEST-CAT.\n\n## Rules\nUse tools carefully.\n';
      const first = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini38',
        systemPrompt: body,
      });
      const again = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini38',
        systemPrompt: body,
      });
      assert.deepEqual(again, first);
      assert.equal(
        first.filePath,
        join(realpathSync(f.base), '.gemini', 'config', 'agents', first.agentName, 'agent.md'),
      );
      assert.match(first.agentName, /^cat-cafe-gemini38-[a-f0-9]{16}$/);
      const markdown = readFileSync(first.filePath, 'utf8');
      assert.match(markdown, /mainAgent: true\nsubagent: false\n/);
      assert.match(markdown, /commandExecutionPolicy: off\n/);
      assert.match(markdown, /inheritMcp: true\n/);
      assert.match(markdown, /tools:\n {2}- view_file\n/);
      assert.ok(markdown.endsWith(body));
      assert.ok(!markdown.includes('run_command'));

      const changed = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini38',
        systemPrompt: `${body}One more rule.\n`,
      });
      assert.notEqual(changed.agentName, first.agentName);
      assert.equal(readFileSync(first.filePath, 'utf8'), markdown);
    } finally {
      f.cleanup();
    }
  });

  test('refuses a code-fence hash line that AGY CLI would treat as a title', () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          materializeAgyNativeAgentFile({
            profileHome: f.base,
            catId: 'gemini38',
            systemPrompt: 'Intro\n```bash\n# shell comment\necho hi\n```\n',
          }),
        /code fence|heading/i,
      );
      assert.throws(
        () =>
          materializeAgyNativeAgentFile({
            profileHome: f.base,
            catId: 'gemini38',
            systemPrompt: 'Intro\n    # indented shell comment\n',
          }),
        /indented|heading/i,
      );
    } finally {
      f.cleanup();
    }
  });

  test('refuses the real user HOME and a symlinked global agent directory', () => {
    const f = fixture();
    try {
      assert.throws(
        () => materializeAgyNativeAgentFile({ profileHome: homedir(), catId: 'gemini38', systemPrompt: 'L0\n' }),
        /real user HOME|isolated/i,
      );
      const target = join(f.base, 'elsewhere');
      symlinkSync(target, join(f.base, '.gemini'));
      assert.throws(
        () => materializeAgyNativeAgentFile({ profileHome: f.base, catId: 'gemini38', systemPrompt: 'L0\n' }),
        /symlink/i,
      );
    } finally {
      f.cleanup();
    }
  });
});
