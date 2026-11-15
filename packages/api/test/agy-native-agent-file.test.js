import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';

const { canonicalAgyNativeBindingBody, materializeAgyNativeAgentFile } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js'
);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

  test('keeps session-binding l0Hash stable across TEAMMATE_ROSTER and USER_CAPSULE churn while Rotating on own identity or governance drift', () => {
    const f = fixture();
    try {
      const profileDir = mkdtempSync(join(f.base, 'owner-profile-'));
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
              catId: 'codex61-sol',
              model: 'gpt-6.1-sol',
              config: {
                name: '缅因猫 Sol 6.1',
                displayName: '缅因猫 Sol',
                nickname: '小太阳',
                mentionPatterns: ['@codex61-sol'],
              },
            },
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

      writeFileSync(join(profileDir, 'capsule.md'), 'CAPSULE-OLD', 'utf8');
      const v1 = buildSnapshot();
      const bodyV1 = renderFrozenL0Input(v1);
      const firstWithFrozen = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: bodyV1,
        frozenL0Input: v1,
      });
      const firstMarkdownOnly = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: bodyV1,
      });
      assert.equal(
        firstMarkdownOnly.l0Hash,
        firstWithFrozen.l0Hash,
        'structured frozenL0Input and rendered Markdown stripping must produce identical l0Hash',
      );
      assert.equal(
        firstMarkdownOnly.volatileL0Context,
        firstWithFrozen.volatileL0Context,
        'structured frozenL0Input and rendered Markdown extraction must produce identical volatileL0Context',
      );
      const firstAgentContent = readFileSync(firstWithFrozen.filePath, 'utf8');
      assert.ok(firstAgentContent.endsWith(`${canonicalAgyNativeBindingBody(bodyV1, v1)}\n`));
      assert.ok(!firstAgentContent.includes('CAPSULE-OLD'), 'agent.md must not freeze volatile USER_CAPSULE on Turn 1');
      assert.ok(!firstAgentContent.includes('@dot'), 'agent.md must not freeze volatile TEAMMATE_ROSTER on Turn 1');
      assert.match(firstWithFrozen.volatileL0Context, /CAPSULE-OLD/);
      assert.match(firstWithFrozen.volatileL0Context, /@dot/);

      // Removing a teammate (@dot retired) and updating owner capsule must NOT rotate l0Hash / agentName,
      // while volatileL0Context reflects the fresh values for per-turn delivery
      writeFileSync(join(profileDir, 'capsule.md'), 'CAPSULE-NEW', 'utf8');
      const v2RosterChanged = buildSnapshot({
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
      const bodyV2 = renderFrozenL0Input(v2RosterChanged);
      const afterRosterDrop = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: bodyV2,
        frozenL0Input: v2RosterChanged,
      });
      assert.equal(afterRosterDrop.l0Hash, firstWithFrozen.l0Hash);
      assert.equal(afterRosterDrop.agentName, firstWithFrozen.agentName);
      const secondAgentContent = readFileSync(afterRosterDrop.filePath, 'utf8');
      assert.equal(secondAgentContent, firstAgentContent, 'immutable session-binding agent.md stays byte-identical');
      assert.match(afterRosterDrop.volatileL0Context, /CAPSULE-NEW/);
      assert.match(afterRosterDrop.volatileL0Context, /@codex61-sol/);
      assert.ok(!afterRosterDrop.volatileL0Context.includes('CAPSULE-OLD'));
      assert.ok(!afterRosterDrop.volatileL0Context.includes('@dot'));

      const bodyWithOwnerCapsuleEdit = bodyV2.replace('CAPSULE-NEW', '默认中文；最近在验收新猫。');
      const afterCapsuleEdit = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: bodyWithOwnerCapsuleEdit,
      });
      assert.equal(afterCapsuleEdit.l0Hash, firstWithFrozen.l0Hash);
      assert.equal(afterCapsuleEdit.agentName, firstWithFrozen.agentName);
      assert.match(afterCapsuleEdit.volatileL0Context, /默认中文；最近在验收新猫。/);
      assert.ok(!afterCapsuleEdit.volatileL0Context.includes('CAPSULE-NEW'));

      // Unlocking own restriction (禁止写代码 removed) MUST rotate l0Hash and agentName
      const v3OwnIdentityChanged = buildSnapshot({
        member: { ...baseMember, restrictions: [] },
      });
      const afterOwnRestrictionRemoved = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: renderFrozenL0Input(v3OwnIdentityChanged),
        frozenL0Input: v3OwnIdentityChanged,
      });
      assert.notEqual(afterOwnRestrictionRemoved.l0Hash, firstWithFrozen.l0Hash);
      assert.notEqual(afterOwnRestrictionRemoved.agentName, firstWithFrozen.agentName);

      // Changing core house governance MUST also rotate l0Hash and agentName
      const v4GovernanceChanged = buildSnapshot({
        governanceText: '## 3. 家规\nRule 0: 边界内保留判断力。\n新增铁律：禁止碰 6399。',
      });
      const afterGovernanceChanged = materializeAgyNativeAgentFile({
        profileHome: f.base,
        catId: 'gemini-carbon',
        systemPrompt: renderFrozenL0Input(v4GovernanceChanged),
        frozenL0Input: v4GovernanceChanged,
      });
      assert.notEqual(afterGovernanceChanged.l0Hash, firstWithFrozen.l0Hash);
    } finally {
      f.cleanup();
    }
  });
});
