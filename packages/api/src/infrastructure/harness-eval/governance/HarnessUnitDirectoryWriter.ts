import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { HarnessUnitAddDraft } from '@cat-cafe/shared';
import YAML from 'yaml';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';

/** TC-17: materialize one approved resolverless hook and its Objective attachment. */
export class HarnessUnitDirectoryWriter {
  private writeQueue = Promise.resolve();

  constructor(
    private readonly deps: {
      projectRoot: string;
      catalog: EvaluationCatalog;
    },
  ) {}

  add(draft: HarnessUnitAddDraft): Promise<void> {
    const write = this.writeQueue.then(() => this.addSerial(draft));
    this.writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async addSerial(draft: HarnessUnitAddDraft): Promise<void> {
    this.validate(draft);
    const hooksRoot = resolve(this.deps.projectRoot, 'assets', 'prompt-hooks');
    const destination = resolve(hooksRoot, draft.assetSlug);
    if (dirname(destination) !== hooksRoot) throw new Error('harness_governance_add_path_invalid');

    const existing = this.deps.catalog.manifest.units.find((unit) => unit.unitId === draft.unitId);
    if (existing) {
      await this.assertExistingFiles(destination, draft);
      if (JSON.stringify(existing.objectives) !== JSON.stringify(draft.objectives)) {
        throw new Error(`harness_governance_add_conflict:${draft.unitId}`);
      }
      return;
    }

    const temporary = await mkdtemp(join(tmpdir(), 'f257-hook-'));
    try {
      await writeFile(join(temporary, 'hook.yaml'), YAML.stringify(draft.manifest), { encoding: 'utf8', flag: 'wx' });
      await writeFile(join(temporary, draft.manifest.template), draft.content, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!(await this.filesMatch(destination, draft))) throw error;
    }

    await this.appendEvaluationUnit(draft);
    this.deps.catalog.manifest.units.push({
      unitId: draft.unitId,
      hookId: draft.assetSlug,
      unitState: 'evaluable',
      objectives: draft.objectives.map((objective) => ({ ...objective })),
    });
  }

  private validate(draft: HarnessUnitAddDraft): void {
    if (!/^[A-Z]+\d+$/u.test(draft.unitId) || draft.manifest.id !== draft.unitId) {
      throw new Error('harness_governance_add_unit_id_invalid');
    }
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.assetSlug) ||
      !draft.assetSlug.startsWith(draft.unitId.toLowerCase())
    ) {
      throw new Error('harness_governance_add_asset_slug_invalid');
    }
    if (
      basename(draft.manifest.template) !== draft.manifest.template ||
      !draft.manifest.template.endsWith('.md') ||
      draft.manifest.version !== 1 ||
      draft.manifest.resolver !== undefined ||
      draft.content.trim().length === 0
    ) {
      throw new Error('harness_governance_add_manifest_invalid');
    }
    if (
      draft.objectives.length !== 1 ||
      draft.objectives[0]?.clauseId !== undefined ||
      !draft.objectives.every((attachment) => this.objectiveExists(attachment.objectiveId))
    ) {
      throw new Error('harness_governance_add_objective_invalid');
    }
    const registry = this.deps.catalog.manifest.units;
    if (registry.some((unit) => unit.hookId === draft.assetSlug)) {
      throw new Error(`harness_governance_add_asset_conflict:${draft.assetSlug}`);
    }
  }

  private objectiveExists(objectiveId: string): boolean {
    return this.deps.catalog.registry.objectives.some(
      (objective) => objective.id === objectiveId && objective.lifecycle !== 'retired',
    );
  }

  private async appendEvaluationUnit(draft: HarnessUnitAddDraft): Promise<void> {
    const path = resolve(
      this.deps.projectRoot,
      'docs',
      'harness-feedback',
      'objectives',
      'unit-evaluation-manifest.yaml',
    );
    const raw = await readFile(path, 'utf8');
    const document = YAML.parse(raw) as { units?: unknown[] };
    if (!Array.isArray(document.units)) throw new Error('harness_governance_unit_manifest_invalid');
    const entry = {
      unitId: draft.unitId,
      hookId: draft.assetSlug,
      unitState: 'evaluable',
      objectives: draft.objectives.map((objective) => ({ ...objective })),
    };
    const present = document.units.find(
      (unit) => typeof unit === 'object' && unit !== null && (unit as { unitId?: unknown }).unitId === draft.unitId,
    );
    if (present) {
      if (JSON.stringify(present) !== JSON.stringify(entry)) {
        throw new Error(`harness_governance_add_conflict:${draft.unitId}`);
      }
      return;
    }
    document.units.push(entry);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, YAML.stringify(document), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  }

  private async assertExistingFiles(destination: string, draft: HarnessUnitAddDraft): Promise<void> {
    if (!(await this.filesMatch(destination, draft))) {
      throw new Error(`harness_governance_add_conflict:${draft.unitId}`);
    }
  }

  private async filesMatch(destination: string, draft: HarnessUnitAddDraft): Promise<boolean> {
    try {
      const manifest = YAML.parse(await readFile(join(destination, 'hook.yaml'), 'utf8'));
      const content = await readFile(join(destination, draft.manifest.template), 'utf8');
      return JSON.stringify(manifest) === JSON.stringify(draft.manifest) && content === draft.content;
    } catch {
      return false;
    }
  }
}
