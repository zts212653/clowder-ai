import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

const TIER_1_CAPABILITIES = [
  { label: 'rich-messaging', wakeup: /rich-messaging/i, inventory: /rich-messaging/i },
  { label: 'browser-preview', wakeup: /browser-preview/i, inventory: /browser-preview/i },
  { label: 'image-generation', wakeup: /image-generation/i, inventory: /image-generation/i },
  { label: 'workspace-navigator', wakeup: /workspace-navigator/i, inventory: /workspace-navigator/i },
  { label: 'pencil-design', wakeup: /pencil-design/i, inventory: /pencil-design/i },
  { label: 'guide-interaction', wakeup: /guide-interaction/i, inventory: /guide-interaction/i },
  { label: 'expert-panel', wakeup: /expert-panel/i, inventory: /expert-panel/i },
  { label: 'cat_cafe_propose_thread', wakeup: /cat_cafe_propose_thread/i, inventory: /cat_cafe_propose_thread/i },
  {
    label: 'F211 external runtime sessions',
    wakeup: /F211[\s\S]*cat_cafe_list_external_runtime_sessions/i,
    inventory: /F211 external runtime sessions/i,
  },
  { label: 'F212 CLI diagnostics', wakeup: /F212[\s\S]*cliDiagnostics/i, inventory: /F212 CLI diagnostics/i },
  {
    label: 'F192 Eval Hub / Verdict Handoff',
    wakeup: /F192 Eval Hub \/ Verdict Handoff/i,
    inventory: /F192 Eval Hub \/ Verdict Handoff/i,
  },
  { label: 'search_evidence', wakeup: /search_evidence/i, inventory: /search_evidence/i },
  { label: 'cat_cafe_update_workflow', wakeup: /cat_cafe_update_workflow/i, inventory: /cat_cafe_update_workflow/i },
];

const F192_HARDCODED_CAPABILITY_SPLIT_THRESHOLD = 5;

function requireMappingBlock(typesSource, exportName) {
  const match = typesSource.match(new RegExp(`export const ${exportName}[\\s\\S]*?};`));
  assert.ok(match, `F192 mapping guard could not find ${exportName}; update the contract before moving it`);
  return match[0];
}

function assertPhaseCMappingGuard(typesSource) {
  const howToBlock = requireMappingBlock(typesSource, 'HOW_TO_PATH_HINTS');
  const skillIdBlock = requireMappingBlock(typesSource, 'CAPABILITY_SKILL_IDS');

  const mappedCapabilities = new Set(
    [...howToBlock.matchAll(/'([^']+)':/g), ...skillIdBlock.matchAll(/'([^']+)':/g)].map((match) => match[1]),
  );

  assert.ok(
    mappedCapabilities.size <= F192_HARDCODED_CAPABILITY_SPLIT_THRESHOLD,
    `F192 capability-wakeup mappings have ${mappedCapabilities.size} hardcoded capabilities; split classifier before adding more`,
  );
}

describe('F223 Phase C capability normalization contract', () => {
  it('keeps all L0 Tier 1 capabilities in both the wakeup index and F223 inventory', () => {
    const wakeupIndex = readRepoFile('cat-cafe-skills/refs/capability-wakeup-index.md');
    const inventory = readRepoFile('docs/features/assets/F223/capability-surface-inventory.md');

    for (const capability of TIER_1_CAPABILITIES) {
      assert.match(wakeupIndex, capability.wakeup, `${capability.label} missing from wakeup index`);
      assert.match(inventory, capability.inventory, `${capability.label} missing from F223 inventory`);
    }

    for (const tableLine of inventory.split('\n').filter((line) => /^\| (?:[1-9]|1[0-3]) \|/.test(line))) {
      assert.match(tableLine, /\| [^|]+ \|$/, `inventory row lacks a recommended action: ${tableLine}`);
      assert.doesNotMatch(tableLine, /\| *TBD *\|/i, `inventory row still has TBD: ${tableLine}`);
    }
  });

  it('keeps underused capability MCPs discoverable through index triggers and tool descriptions', () => {
    const wakeupIndex = readRepoFile('cat-cafe-skills/refs/capability-wakeup-index.md');
    const callbackTools = readRepoFile('packages/mcp-server/src/tools/callback-tools.ts');
    const externalRuntimeTools = readRepoFile('packages/mcp-server/src/tools/external-runtime-session-tools.ts');

    assert.match(wakeupIndex, /cat_cafe_start_vote[\s\S]*结构化表决/);
    assert.match(callbackTools, /cat_cafe_start_vote[\s\S]*Use when[\s\S]*decision/i);
    assert.match(callbackTools, /cat_cafe_start_vote[\s\S]*Output:[\s\S]*vote/i);

    assert.match(wakeupIndex, /cat_cafe_multi_mention[\s\S]*一次性 @ 多猫/);
    assert.match(callbackTools, /cat_cafe_multi_mention[\s\S]*REQUIRES: searchEvidenceRefs/);

    assert.match(wakeupIndex, /cat_cafe_generate_document[\s\S]*正式 DOCX\/PDF/);
    assert.match(callbackTools, /cat_cafe_generate_document[\s\S]*Use when[\s\S]*document generation/i);
    assert.match(callbackTools, /cat_cafe_generate_document[\s\S]*Do NOT manually run pandoc/i);

    assert.match(wakeupIndex, /cat_cafe_update_workflow[\s\S]*阶段进度只在聊天里说/);
    assert.match(callbackTools, /cat_cafe_update_workflow[\s\S]*Use to record current stage/);
    assert.match(callbackTools, /cat_cafe_update_workflow[\s\S]*resumeCapsule/);

    assert.match(wakeupIndex, /cat_cafe_list_external_runtime_sessions/);
    assert.match(wakeupIndex, /cat_cafe_read_external_runtime_session/);
    assert.match(
      externalRuntimeTools,
      /cat_cafe_list_external_runtime_sessions[\s\S]*Use when[\s\S]*external runtime session/i,
    );
    assert.match(externalRuntimeTools, /cat_cafe_read_external_runtime_session[\s\S]*Use after list/i);
  });

  it('guards F192 capability-wakeup hardcoded capability mappings from growing past five', () => {
    const typesSource = readRepoFile(
      'packages/api/src/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-types.ts',
    );
    assertPhaseCMappingGuard(typesSource);
  });

  it('allows fourth and fifth F192 hardcoded mappings before the classifier split threshold', () => {
    assertPhaseCMappingGuard(`
      export const HOW_TO_PATH_HINTS = {
        'rich-messaging': 'cat-cafe-skills/rich-messaging/SKILL.md',
        'workspace-navigator': 'cat-cafe-skills/workspace-navigator/SKILL.md',
        'browser-preview': 'cat-cafe-skills/browser-preview/SKILL.md',
        'new-capability-a': 'cat-cafe-skills/new-capability-a/SKILL.md',
        'new-capability-b': 'cat-cafe-skills/new-capability-b/SKILL.md',
      };
      export const CAPABILITY_SKILL_IDS = {};
    `);
  });

  it('fails once F192 hardcoded mappings exceed the Phase C threshold', () => {
    assert.throws(
      () =>
        assertPhaseCMappingGuard(`
          export const HOW_TO_PATH_HINTS = {
            'rich-messaging': 'cat-cafe-skills/rich-messaging/SKILL.md',
            'workspace-navigator': 'cat-cafe-skills/workspace-navigator/SKILL.md',
            'browser-preview': 'cat-cafe-skills/browser-preview/SKILL.md',
            'new-capability-a': 'cat-cafe-skills/new-capability-a/SKILL.md',
            'new-capability-b': 'cat-cafe-skills/new-capability-b/SKILL.md',
            'new-capability-c': 'cat-cafe-skills/new-capability-c/SKILL.md',
          };
          export const CAPABILITY_SKILL_IDS = {};
        `),
      /split classifier before adding more/,
    );
  });

  it('fails closed when an F192 hardcoded mapping block is missing', () => {
    assert.throws(
      () =>
        assertPhaseCMappingGuard(`
          export const HOW_TO_PATH_HINTS = {
            'rich-messaging': 'cat-cafe-skills/rich-messaging/SKILL.md',
          };
        `),
      /CAPABILITY_SKILL_IDS/,
    );

    assert.throws(
      () =>
        assertPhaseCMappingGuard(`
          export const CAPABILITY_SKILL_IDS = {
            'rich-messaging': 'rich-messaging',
          };
        `),
      /HOW_TO_PATH_HINTS/,
    );
  });
});
