import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freezeL0Input, renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';

const { canonicalAgyNativeBindingBody, materializeAgyNativeAgentFile } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js'
);
const { partitionAgyNativeL0Markdown } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/launch/agy-native-l0-rules.js'
);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-agent-file-'));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('F325 native L0 agent and live always_on rules artifact', () => {
  test('keeps agentName and agent.md immutable while refreshing canonical L0 in always_on rules across nickname, governance, roster, capsule and guidance edits', () => {
    const f = fixture();
    try {
      const profileDir = mkdtempSync(join(f.base, 'owner-profile-'));
      writeFileSync(join(profileDir, 'capsule.md'), 'CAPSULE-OLD', 'utf8');
      const baseMember = {
        name: '暹罗猫 Gemini 4 Carbon',
        displayName: '暹罗猫',
        nickname: '烁烁',
        breedId: 'siamese',
        relationshipKey: 'siamese',
        roleDescription: 'AGY Native 独立成员',
        personality: '新猫；保留自己的判断',
        restrictions: ['禁止写代码'],
      };
      const buildSnapshot = (overrides = {}) =>
        captureFrozenL0Input({
          catId: 'gemini-carbon',
          projection: 'owner',
          installRoot: REPO_ROOT,
          overlayRoot: REPO_ROOT,
          dossierRoot: REPO_ROOT,
          profileDir,
          governanceText: '## 3. 家规\nRule 0: 边界内保留判断力。',
          member: baseMember,
          model: 'gemini-4-carbon-high',
          coCreator: { name: 'You', mentionPatterns: ['@co-creator'] },
          teammates: [
            {
              catId: 'dot',
              model: 'claude-opus-5-5-high',
              config: {
                name: '布偶猫 Dot',
                displayName: '布偶猫',
                nickname: '点点',
                mentionPatterns: ['@dot'],
              },
            },
          ],
          ...overrides,
        });

      const v1 = buildSnapshot();
      const first = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: renderFrozenL0Input(v1),
        frozenL0Input: v1,
      });
      assert.equal(first.agentName, 'cat-cafe-host-gemini-carbon');
      assert.equal(
        first.filePath,
        join(realpathSync(f.base), '.gemini', 'config', 'agents', 'cat-cafe-host-gemini-carbon', 'agent.md'),
      );
      assert.ok(first.rulePaths.length >= 1);
      const firstAgentContent = readFileSync(first.filePath, 'utf8');
      assert.match(firstAgentContent, /mainAgent: true\nsubagent: false\n/);
      assert.match(firstAgentContent, /commandExecutionPolicy: off\n/);
      assert.match(firstAgentContent, /inheritMcp: true\n/);
      assert.match(firstAgentContent, /tools:\n {2}- view_file\n/);
      assert.ok(!firstAgentContent.includes('烁烁'), 'Turn-1 agent.md must not freeze mutable nickname');
      assert.ok(!firstAgentContent.includes('禁止写代码'), 'Turn-1 agent.md must not freeze mutable restrictions');
      assert.ok(!firstAgentContent.includes('CAPSULE-OLD'), 'Turn-1 agent.md must not freeze volatile capsule');
      const firstRulesText = first.rulePaths.map((p) => readFileSync(p, 'utf8')).join('\n');
      assert.match(firstRulesText, /trigger: always_on/);
      assert.match(firstRulesText, /烁烁/);
      assert.match(firstRulesText, /禁止写代码/);
      assert.match(firstRulesText, /CAPSULE-OLD/);
      assert.match(firstRulesText, /@dot/);

      // Edit nickname, unlock restriction, update governance, capsule, roster, and L5/L6 guidance
      writeFileSync(join(profileDir, 'capsule.md'), 'CAPSULE-NEW', 'utf8');
      const v2Base = buildSnapshot({
        member: { ...baseMember, nickname: '碳碳·烁烁', restrictions: [] },
        governanceText: '## 3. 家规\nRule 0: 边界内保留判断力。\n新增铁律：禁止碰 6399。',
        teammates: [
          {
            catId: 'codex61-sol',
            model: 'gpt-6.1-sol',
            config: {
              name: '缅因猫 Sol 6.1',
              displayName: '缅因猫 Sol',
              nickname: '小太阳',
              mentionPatterns: ['@codex61-sol'],
            },
          },
        ],
      });
      const v2 = freezeL0Input({
        ...v2Base,
        sections: {
          ...v2Base.sections,
          L5_CONTENT: 'TOOLS-UPDATED',
          L6_CONTENT: 'CAPABILITY-UPDATED',
        },
      });
      const second = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: renderFrozenL0Input(v2),
        frozenL0Input: v2,
      });
      assert.equal(second.agentName, first.agentName, 'host agentName stays stable across all L0 updates');
      assert.equal(
        readFileSync(second.filePath, 'utf8'),
        firstAgentContent,
        'host contract agent.md stays byte-identical',
      );
      assert.notEqual(second.l0Hash, first.l0Hash, 'l0Hash still records provenance of new L0 revision');
      const secondRulesText = second.rulePaths.map((p) => readFileSync(p, 'utf8')).join('\n');
      assert.match(secondRulesText, /碳碳·烁烁/);
      assert.ok(!secondRulesText.includes('禁止写代码'));
      assert.match(secondRulesText, /新增铁律：禁止碰 6399/);
      assert.match(secondRulesText, /CAPSULE-NEW/);
      assert.ok(!secondRulesText.includes('CAPSULE-OLD'));
      assert.match(secondRulesText, /@codex61-sol/);
      assert.ok(!secondRulesText.includes('@dot'));
      assert.match(secondRulesText, /TOOLS-UPDATED/);
      assert.match(secondRulesText, /CAPABILITY-UPDATED/);
      assert.equal(canonicalAgyNativeBindingBody('  hello\r\n\r\n\r\nworld  '), 'hello\n\nworld');
    } finally {
      f.cleanup();
    }
  });

  test('partitions oversized L0 deterministically across fence-safe UTF-8 chunks without dropping content', () => {
    const fencedBlock = [
      '```bash',
      ...Array.from({ length: 120 }, (_, i) => `# comment line ${i + 1}: 保持围栏闭合与中文 UTF-8 完整`),
      '```',
    ].join('\n');
    const longLine = `超长单行测试-${'猫猫伙伴平权连续工作'.repeat(300)}-END`;
    const source = ['# Header', fencedBlock, longLine, 'FINAL-SENTINEL'].join('\n\n');
    const chunks = partitionAgyNativeL0Markdown(source, 2048);
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 2048);
    }
    const combined = chunks.join('\n');
    assert.match(combined, /^# Header/);
    assert.match(combined, /comment line 1:/);
    assert.match(combined, /comment line 120:/);
    assert.match(combined, /FINAL-SENTINEL$/);
  });

  test('scopedMember still refuses a code-fence hash line inside agent.md that AGY CLI would treat as a title', () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          materializeAgyNativeAgentFile({
            profileHome: f.base,
            catId: 'gemini38',
            scopedMember: true,
            systemPrompt: 'Intro\n```bash\n# shell comment\necho hi\n```\n',
          }),
        /code fence|heading/i,
      );
      assert.throws(
        () =>
          materializeAgyNativeAgentFile({
            profileHome: f.base,
            catId: 'gemini38',
            scopedMember: true,
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
