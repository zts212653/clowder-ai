import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function assertIntakeTargetLineage({ targetRepo, ledger, targetHead, targetBranch }) {
  // Records written before branch roles existed refer to the historical main lane.
  const ledgerBranch = ledger.target_branch === undefined ? 'main' : ledger.target_branch;
  if (ledgerBranch !== targetBranch) {
    throw new Error(`intake ledger branch ${ledgerBranch} differs from integration branch ${targetBranch}`);
  }
  const reviewedHead = ledger.last_reviewed_target_head;
  if (!/^[0-9a-f]{40}$/.test(targetHead) || (reviewedHead && !/^[0-9a-f]{40}$/.test(reviewedHead))) {
    throw new Error('intake lineage requires full commit SHAs');
  }
  if (reviewedHead) {
    try {
      execFileSync('git', ['-C', targetRepo, 'merge-base', '--is-ancestor', reviewedHead, targetHead], {
        stdio: 'pipe',
      });
    } catch (cause) {
      throw new Error(
        `intake reviewed head ${reviewedHead} is not an ancestor of ${targetHead}; refuse watermark rollback or divergence`,
        { cause },
      );
    }
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [targetRepo, ledgerPath, targetHead, targetBranch] = process.argv.slice(2);
    if (!targetRepo || !ledgerPath || !['main', 'next'].includes(targetBranch)) {
      throw new Error(
        'usage: intake-target-lineage.mjs <target-repo> <ledger-json> <target-head> <integration-branch>',
      );
    }
    assertIntakeTargetLineage({
      targetRepo,
      ledger: JSON.parse(readFileSync(ledgerPath, 'utf8')),
      targetHead,
      targetBranch,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
