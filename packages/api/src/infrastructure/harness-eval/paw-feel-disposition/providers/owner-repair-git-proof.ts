interface PawFeelOwnerRepairGitTruth {
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(fromRevision: string, toRevision: string): Promise<readonly string[]>;
}

export interface PawFeelOwnerRepairGitProof {
  mode: 'already_loaded' | 'loaded_after_binding';
  changedFiles: string[];
}

export async function verifyPawFeelOwnerRepairGitProof(input: {
  label: string;
  baselineRevision: string;
  loadedRevision: string | null;
  mainRevision: string | null;
  gitTruth: PawFeelOwnerRepairGitTruth;
  isRelevantPath(path: string): boolean;
}): Promise<PawFeelOwnerRepairGitProof> {
  const { baselineRevision, loadedRevision, mainRevision } = input;
  if (!loadedRevision || !mainRevision) {
    throw new Error(`${input.label} outcome has no loaded or current-main revision`);
  }
  if (
    !(await input.gitTruth.isAncestor(baselineRevision, loadedRevision)) ||
    !(await input.gitTruth.isAncestor(loadedRevision, mainRevision))
  ) {
    throw new Error(`${input.label} loaded repair is not on the current main ancestry`);
  }
  if (baselineRevision === loadedRevision) {
    return { mode: 'already_loaded', changedFiles: [] };
  }

  const changedFiles = [...new Set(await input.gitTruth.changedFiles(baselineRevision, loadedRevision))]
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  if (changedFiles.length === 0 || changedFiles.length > 200 || !changedFiles.some(input.isRelevantPath)) {
    throw new Error(`${input.label} outcome has no bounded repair delta`);
  }
  return { mode: 'loaded_after_binding', changedFiles };
}
