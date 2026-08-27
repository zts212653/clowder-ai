import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkClaimContract, checkClaimDirectory } from './design-gate-real-interaction.mjs';

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

function withFixtureRepo(run) {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'design-gate-claim-'));
  const write = (relativePath, content) => {
    const absolutePath = resolve(fixtureRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  };

  try {
    return run({ fixtureRoot, write });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function validIntegratedContract() {
  return {
    schemaVersion: 1,
    id: 'fixture-integrated-workspace',
    classification: 'product_candidate',
    claims: {
      productIntegration: {
        userEntry: 'Collective → Channel → Artifact',
        mountChain: [
          { path: 'src/Entry.tsx', export: 'Entry' },
          { path: 'src/Host.tsx', export: 'Host' },
          { path: 'src/Surface.tsx', export: 'Surface' },
        ],
      },
      documentEditor: {
        engine: {
          package: '@codemirror/view',
          version: '^6.0.0',
          license: 'MIT',
          source: 'https://codemirror.net/',
        },
        packageManifestPath: 'package.json',
        adapter: { path: 'src/ArtifactEditor.tsx', export: 'ArtifactEditor' },
        mount: { path: 'src/Surface.tsx', export: 'Surface' },
        contracts: {
          human_edit: ['humanEdit'],
          selection_anchor: ['selectionAnchor'],
          annotation: ['createAnnotation'],
          patch_review: ['reviewPatch'],
          version_undo: ['undoVersion'],
        },
      },
    },
  };
}

function writeValidIntegratedFixture(write) {
  write('package.json', JSON.stringify({ dependencies: { '@codemirror/view': '^6.0.0' } }));
  write('src/Entry.tsx', "import { Host } from './Host';\nexport function Entry() { return <Host />; }\n");
  write('src/Host.tsx', "import { Surface } from './Surface';\nexport function Host() { return <Surface />; }\n");
  write(
    'src/Surface.tsx',
    "import { ArtifactEditor } from './ArtifactEditor';\nexport function Surface() { return <ArtifactEditor />; }\n",
  );
  write(
    'src/ArtifactEditor.tsx',
    "import { EditorView } from '@codemirror/view';\nconst humanEdit = EditorView.editable;\nconst selectionAnchor = 'selectionAnchor';\nconst createAnnotation = 'createAnnotation';\nconst reviewPatch = 'reviewPatch';\nconst undoVersion = 'undoVersion';\nexport function ArtifactEditor() { return <div data-editor={humanEdit} />; }\n",
  );
}

describe('Design Gate committed claim-evidence checker', () => {
  it('普通 component experiment 没有 product/editor claim 时不进入加严车道', () => {
    withFixtureRepo(({ fixtureRoot }) => {
      const result = checkClaimContract({
        repoRoot: fixtureRoot,
        contract: {
          schemaVersion: 1,
          id: 'component-only',
          classification: 'component_experiment',
          claims: {},
        },
      });
      assert.equal(result.ok, true, result.errors.join('\n'));
    });
  });

  it('显式声明 product/editor claim 却提交空对象时 fail closed', () => {
    withFixtureRepo(({ fixtureRoot }) => {
      const result = checkClaimContract({
        repoRoot: fixtureRoot,
        contract: {
          schemaVersion: 1,
          id: 'empty-claim',
          classification: 'product_candidate',
          claims: { productIntegration: null },
        },
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /productIntegration claim must be an object/u);
    });
  });

  it('提交式 contract 必须由所属 feature doc 显式引用', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      const contractPath = 'docs/design-gate-claims/f1.json';
      const contract = {
        schemaVersion: 1,
        id: 'f1-claim',
        classification: 'component_experiment',
        source: { feature: 'F001', featureDocPath: 'docs/features/F001.md' },
        claims: {},
      };
      write(contractPath, JSON.stringify(contract));
      write('docs/features/F001.md', `---\nfeature_ids: [F001]\ndesign_gate_claim_contracts: [${contractPath}]\n---\n`);
      assert.equal(checkClaimDirectory({ repoRoot: fixtureRoot }).ok, true);

      write('docs/features/F001.md', '---\nfeature_ids: [F001]\ndesign_gate_claim_contracts: []\n---\n');
      const result = checkClaimDirectory({ repoRoot: fixtureRoot });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /feature doc must reference/u);
    });
  });

  it('提交式 contract 的 source.feature 必须与 feature doc owner 一致', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      const contractPath = 'docs/design-gate-claims/f307.json';
      const contract = {
        schemaVersion: 1,
        id: 'f307-claim',
        classification: 'component_experiment',
        source: { feature: 'F290', featureDocPath: 'docs/features/F307.md' },
        claims: {},
      };
      write(contractPath, JSON.stringify(contract));
      write('docs/features/F307.md', `---\nfeature_ids: [F307]\ndesign_gate_claim_contracts: [${contractPath}]\n---\n`);

      const wrongOwner = checkClaimDirectory({ repoRoot: fixtureRoot });
      assert.equal(wrongOwner.ok, false);
      assert.match(wrongOwner.errors.join('\n'), /source\.feature.*feature_ids/u);

      delete contract.source.feature;
      write(contractPath, JSON.stringify(contract));
      const missingOwner = checkClaimDirectory({ repoRoot: fixtureRoot });
      assert.equal(missingOwner.ok, false);
      assert.match(missingOwner.errors.join('\n'), /source\.feature is required/u);
    });
  });

  it('合同路径只出现在 feature doc 正文时不算 frontmatter 引用', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      const contractPath = 'docs/design-gate-claims/f307.json';
      const contract = {
        schemaVersion: 1,
        id: 'f307-claim',
        classification: 'component_experiment',
        source: { feature: 'F307', featureDocPath: 'docs/features/F307.md' },
        claims: {},
      };
      write(contractPath, JSON.stringify(contract));
      write(
        'docs/features/F307.md',
        `---\nfeature_ids: [F307]\ndesign_gate_claim_contracts: []\n---\n\nMention: ${contractPath}\n`,
      );

      const result = checkClaimDirectory({ repoRoot: fixtureRoot });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /feature doc must reference/u);
    });
  });

  it('product claim 必须由真实入口到 surface 的逐跳 import/mount 关系承载', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract: validIntegratedContract() });
      assert.equal(result.ok, true, result.errors.join('\n'));
    });
  });

  it('独立 /dev 壳不能作为 product integration 的入口', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const contract = validIntegratedContract();
      contract.claims.productIntegration.mountChain[0].path = 'src/app/dev/Entry.tsx';
      write(
        'src/app/dev/Entry.tsx',
        "import { Host } from '../../../Host';\nexport function Entry() { return <Host />; }\n",
      );
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /\/dev\/|dev route/u);
    });
  });

  it('只写宿主路径、没有 import/mount surface 时必须失败', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write('src/Host.tsx', 'export function Host() { return <main />; }\n');
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract: validIntegratedContract() });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /Surface.*import|import.*Surface/u);
    });
  });

  it('document editor claim 必须导入已声明引擎、挂入 surface 并覆盖五项契约', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const contract = validIntegratedContract();
      contract.claims.documentEditor.contracts.patch_review = ['missingPatchReview'];
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /patch_review.*missingPatchReview/u);
    });
  });

  it('editor adapter 必须挂在同一 product mount chain 的最终 surface', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write(
        'src/DetachedEditorSurface.tsx',
        "import { ArtifactEditor } from './ArtifactEditor';\nexport function DetachedEditorSurface() { return <ArtifactEditor />; }\n",
      );
      const contract = validIntegratedContract();
      contract.claims.documentEditor.mount = {
        path: 'src/DetachedEditorSurface.tsx',
        export: 'DetachedEditorSurface',
      };
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /final surface/u);
    });
  });

  it('原生 textarea 不能冒充成熟 editor adapter', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write(
        'src/ArtifactEditor.tsx',
        "import { EditorView } from '@codemirror/view';\nconst humanEdit = EditorView.editable;\nconst selectionAnchor = 'selectionAnchor';\nconst createAnnotation = 'createAnnotation';\nconst reviewPatch = 'reviewPatch';\nconst undoVersion = 'undoVersion';\nexport function ArtifactEditor() { return <textarea />; }\n",
      );
      const result = checkClaimContract({ repoRoot: fixtureRoot, contract: validIntegratedContract() });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /textarea/u);
    });
  });
});
