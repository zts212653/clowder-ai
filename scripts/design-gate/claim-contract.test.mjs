import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkClaimContract, checkClaimDirectory } from '../design-gate-real-interaction.mjs';
import {
  expectAccepted,
  expectRejected,
  productContract,
  validIntegratedContract,
  withFixtureRepo,
  writeValidIntegratedFixture,
} from './test-fixtures.mjs';

const repoRoot = process.env.DESIGN_GATE_TEST_REPO_ROOT
  ? resolve(process.env.DESIGN_GATE_TEST_REPO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('product claim 必须由真实入口到 surface 的逐跳 import/mount 关系承载，并绑定默认入口旅程', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      expectAccepted(fixtureRoot, validIntegratedContract());
    });
  });

  it('accepts NodeNext source imports that spell a TypeScript surface with its emitted .js path', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write(
        'packages/web/src/Entry.tsx',
        "import { Host } from './Host.js';\nexport function Entry() { return <Host />; }\n",
      );
      write(
        'packages/web/src/Host.tsx',
        "import { Surface } from './Surface.js';\nexport function Host() { return <Surface />; }\n",
      );
      expectAccepted(fixtureRoot, productContract());
    });
  });

  it('独立 /dev 壳不能作为 product integration 的入口', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const contract = productContract();
      contract.claims.productIntegration.mountChain[0].path = 'packages/web/src/app/dev/Entry.tsx';
      write(
        'packages/web/src/app/dev/Entry.tsx',
        "import { Host } from '../../Host';\nexport function Entry() { return <Host />; }\n",
      );
      expectRejected(fixtureRoot, contract, /dev route/u);
    });
  });

  it('只写宿主路径、没有 import/mount surface 时必须失败', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write('packages/web/src/Host.tsx', 'export function Host() { return <main />; }\n');
      expectRejected(fixtureRoot, validIntegratedContract(), /Host must import Surface/u);
    });
  });

  it('没有 claim 的 entry 结构披露也必须逐跳成立，否则披露是陈旧的', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const disclosure = {
        schemaVersion: 1,
        id: 'opt-in-candidate',
        classification: 'opt_in_experience_candidate',
        entry: {
          mode: 'opt_in',
          reachableFromDefaultEntry: false,
          mountChain: [
            { path: 'packages/web/src/Entry.tsx', export: 'Entry' },
            { path: 'packages/web/src/Host.tsx', export: 'Host' },
            { path: 'packages/web/src/Surface.tsx', export: 'Surface' },
          ],
        },
        claims: {},
      };
      expectAccepted(fixtureRoot, disclosure);

      write(
        'packages/web/src/Host.tsx',
        "import { Surface } from './Surface';\nexport function Host() { return <main />; }\n",
      );
      expectRejected(fixtureRoot, disclosure, /entry\.mountChain\[1\]: Host must mount <Surface>/u);
    });
  });

  it('document editor claim 必须导入已声明引擎、挂入 surface 并覆盖五项契约', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      const contract = validIntegratedContract();
      contract.claims.documentEditor.contracts.patch_review = ['missingPatchReview'];
      expectRejected(fixtureRoot, contract, /patch_review.*missingPatchReview/u);
    });
  });

  it('editor adapter 必须挂在同一 product mount chain 的最终 surface', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write(
        'packages/web/src/DetachedEditorSurface.tsx',
        "import { ArtifactEditor } from './ArtifactEditor';\nexport function DetachedEditorSurface() { return <ArtifactEditor />; }\n",
      );
      const contract = validIntegratedContract();
      contract.claims.documentEditor.mount = {
        path: 'packages/web/src/DetachedEditorSurface.tsx',
        export: 'DetachedEditorSurface',
      };
      expectRejected(fixtureRoot, contract, /final surface/u);
    });
  });

  it('原生 textarea 不能冒充成熟 editor adapter', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      writeValidIntegratedFixture(write);
      write(
        'packages/web/src/ArtifactEditor.tsx',
        "import { EditorView } from '@codemirror/view';\nconst humanEdit = EditorView.editable;\nconst selectionAnchor = 'selectionAnchor';\nconst createAnnotation = 'createAnnotation';\nconst reviewPatch = 'reviewPatch';\nconst undoVersion = 'undoVersion';\nexport function ArtifactEditor() { return <textarea />; }\n",
      );
      expectRejected(fixtureRoot, validIntegratedContract(), /textarea/u);
    });
  });

  it('the committed claims directory passes against the real tree', () => {
    const result = checkClaimDirectory({ repoRoot });
    assert.equal(result.ok, true, result.errors.join('\n'));
    if (!existsSync(resolve(repoRoot, 'docs/design-gate-claims'))) {
      assert.equal(result.checked, 0);
      return;
    }
    assert.equal(result.checked, 4);
  });
});
