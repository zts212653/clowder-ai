import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Shared-policy contract for the Design Gate real-interaction rules. The committed
// claim-evidence checker itself is exercised in scripts/design-gate/*.test.mjs.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function sourcePolicy() {
  const sources = [
    read('cat-cafe-skills/concept-demo-design/SKILL.md'),
    read('cat-cafe-skills/concept-demo-design/refs/demo-contract-template.md'),
    read('cat-cafe-skills/refs/design-in-context-checklist.md'),
    read('cat-cafe-skills/feat-lifecycle/SKILL.md'),
  ];

  return {
    realInteraction: sources.every(
      (source) =>
        /真实交互 claim/u.test(source) && /陌生 sentinel/u.test(source) && /可重放(?:浏览器)?旅程/u.test(source),
    ),
    integratedProductHost: sources.every(
      (source) => /真实产品宿主/u.test(source) && /宿主挂载证据/u.test(source) && /独立复制壳/u.test(source),
    ),
    documentEditorEngine: sources.every(
      (source) => /成熟编辑器引擎/u.test(source) && /编辑器适配契约/u.test(source) && /textarea/u.test(source),
    ),
    committedClaimEvidence: sources.every(
      (source) =>
        /docs\/design-gate-claims\/<id>\.json/u.test(source) && /import\/?mount|import.*mount/isu.test(source),
    ),
    defaultEntryIsTheGate: sources.every(
      (source) => /默认入口即门/u.test(source) && /defaultEntryJourney/u.test(source) && /opt-in/u.test(source),
    ),
  };
}

function gateAccepts(demo, policy) {
  if (demo.deliveryClaims.length === 0) return true;
  if (!policy) return true;

  const semanticInput = demo.coreInput?.semantic === true;
  const statefulAction =
    demo.coreAction?.hasHandler === true &&
    demo.coreAction?.changesState === true &&
    demo.coreAction?.presetSceneOnly !== true;
  const sentinelIsNovel = !demo.fixtureText.includes(demo.sentinel);
  const sentinelReachedState = [demo.observedDom, demo.observedStore].some((value) => value?.includes(demo.sentinel));
  const semanticsAreExplicit = demo.deliveryClaims.every(
    ({ userMeaning, stateConsequence }) => userMeaning?.trim() && stateConsequence?.trim(),
  );
  const recoveryIsProven = !demo.claimsRecovery || Boolean(demo.afterRefresh?.includes(demo.sentinel));
  const integratedProductClaimIsProven =
    !demo.claimsIntegratedProduct ||
    (policy.integratedProductHost &&
      demo.productHost?.kind === 'existing_product_host' &&
      Boolean(demo.productHost?.realEntry?.trim()) &&
      Boolean(demo.productHost?.mountEvidence?.trim()) &&
      demo.productHost?.standaloneReplica !== true);
  const documentEditingClaimIsProven =
    !demo.claimsDocumentEditing ||
    (policy.documentEditorEngine &&
      demo.editor?.kind === 'embedded_engine' &&
      Boolean(demo.editor?.engineId?.trim()) &&
      ['human_edit', 'selection_anchor', 'annotation', 'patch_review', 'version_undo'].every((capability) =>
        demo.editor?.adapterContracts?.includes(capability),
      ));

  return (
    policy.realInteraction &&
    semanticInput &&
    statefulAction &&
    sentinelIsNovel &&
    sentinelReachedState &&
    semanticsAreExplicit &&
    recoveryIsProven &&
    integratedProductClaimIsProven &&
    documentEditingClaimIsProven
  );
}

const staticScenery = {
  demoKind: 'product_experience_gate',
  deliveryClaims: [{ userMeaning: '给项目写批注', stateConsequence: '显示一条新批注' }],
  coreInput: { semantic: false },
  coreAction: { hasHandler: false, changesState: false, presetSceneOnly: true },
  fixtureText: '预写批注 A',
  sentinel: '陌生 sentinel：operator 刚写的批注',
  observedDom: '预写批注 B',
  observedStore: '',
  claimsRecovery: false,
};

const realInteraction = {
  demoKind: 'journey_validation',
  deliveryClaims: [{ userMeaning: '给项目写批注', stateConsequence: '新增一条可见的协同记录' }],
  coreInput: { semantic: true },
  coreAction: { hasHandler: true, changesState: true, presetSceneOnly: false },
  fixtureText: '已有批注',
  sentinel: '陌生 sentinel：operator 刚写的批注',
  observedDom: '协同记录：陌生 sentinel：operator 刚写的批注',
  observedStore: '',
  claimsRecovery: true,
  afterRefresh: '协同记录：陌生 sentinel：operator 刚写的批注',
};

describe('Design Gate real-interaction contract', () => {
  it('共享说明把 product/editor claim 路由到提交式机器证据，而不是测试 fixture', () => {
    assert.equal(sourcePolicy().committedClaimEvidence, true);
  });

  it('共享说明写明默认入口即门：每个 productIntegration 绑定 full gate 实跑的 defaultEntryJourney，opt-in 候选页进不了 claim', () => {
    assert.equal(sourcePolicy().defaultEntryIsTheGate, true);
  });

  it('“看起来能输入，结果只是切换预写内容”不能通过', () => {
    assert.equal(gateAccepts(staticScenery, sourcePolicy()), false);
  });

  it('陌生 sentinel 经语义输入和动作后产生新状态，且恢复 claim 经刷新验证', () => {
    assert.equal(gateAccepts(realInteraction, sourcePolicy()), true);
  });

  it('没有恢复 claim 的真实交互不被强加刷新或持久化', () => {
    assert.equal(
      gateAccepts({ ...realInteraction, claimsRecovery: false, afterRefresh: undefined }, sourcePolicy()),
      true,
    );
  });

  it('声称恢复却没有刷新证据时不能通过', () => {
    assert.equal(gateAccepts({ ...realInteraction, afterRefresh: undefined }, sourcePolicy()), false);
  });

  it('concept_story 的预设叙事和场景控制不被误伤', () => {
    assert.equal(
      gateAccepts(
        {
          demoKind: 'concept_story',
          deliveryClaims: [],
          coreInput: { semantic: false },
          coreAction: { presetSceneOnly: true },
          fixtureText: '预设叙事',
          sentinel: '不适用',
        },
        sourcePolicy(),
      ),
      true,
    );
  });
});
