// F102: IMaterializationService — approved marker → .md file → trigger reindex
// Phase A: basic skeleton; Phase B: full .md patch + git commit

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  EvidenceKind,
  IIndexBuilder,
  IMarkerQueue,
  IMaterializationService,
  MaterializeResult,
} from './interfaces.js';
import { EVIDENCE_KINDS } from './interfaces.js';

const KIND_TO_DIR: Record<EvidenceKind, string> = {
  feature: 'features',
  decision: 'decisions',
  plan: 'plans',
  session: 'evidence',
  lesson: 'lessons',
  thread: 'evidence',
  discussion: 'discussions',
  research: 'research',
  'pack-knowledge': 'pack-knowledge',
};

export class MaterializationService implements IMaterializationService {
  constructor(
    private readonly markerQueue: IMarkerQueue,
    private readonly docsRoot: string,
    private readonly indexBuilder?: Pick<IIndexBuilder, 'incrementalUpdate'>,
  ) {}

  async canMaterialize(markerId: string): Promise<boolean> {
    const markers = await this.markerQueue.list();
    const marker = markers.find((m) => m.id === markerId);
    return marker?.status === 'approved';
  }

  async materialize(markerId: string): Promise<MaterializeResult> {
    const markers = await this.markerQueue.list();
    const marker = markers.find((m) => m.id === markerId);
    if (!marker) throw new Error(`Marker not found: ${markerId}`);
    if (marker.status !== 'approved') {
      throw new Error(`Marker ${markerId} not approved (status: ${marker.status})`);
    }

    // Validate and determine output path based on targetKind
    const kind = marker.targetKind ?? 'lesson';
    if (!EVIDENCE_KINDS.includes(kind)) {
      throw new Error(`Invalid targetKind: ${kind}`);
    }
    const anchor = `${kind}-${markerId}`;
    const subDir = KIND_TO_DIR[kind];
    const dir = join(this.docsRoot, subDir);
    mkdirSync(dir, { recursive: true });

    // Conflict handling: append -N suffix if file already exists
    let outputPath = join(dir, `${anchor}.md`);
    if (existsSync(outputPath)) {
      let n = 2;
      while (existsSync(join(dir, `${anchor}-${n}.md`))) n++;
      outputPath = join(dir, `${anchor}-${n}.md`);
    }

    // Write .md file with frontmatter
    const frontmatter = [
      '---',
      `anchor: ${anchor}`,
      `doc_kind: ${kind}`,
      `materialized_from: ${markerId}`,
      `created: ${new Date().toISOString().split('T')[0]}`,
    ];
    if (marker.targetCollectionId) frontmatter.push(`target_collection: ${marker.targetCollectionId}`);
    if (marker.sourceCollectionId) frontmatter.push(`source_collection: ${marker.sourceCollectionId}`);
    frontmatter.push('---');
    const md = [...frontmatter, '', marker.content, ''].join('\n');
    writeFileSync(outputPath, md);

    // Git commit the materialized file (parameterized — no shell interpolation)
    let committed = false;
    try {
      const cwd = dirname(outputPath);
      execFileSync('git', ['add', outputPath], { cwd, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', `materialize: ${anchor}`], { cwd, stdio: 'pipe' });
      committed = true;
    } catch {
      // Not in a git repo or commit failed — continue gracefully
    }

    // Trigger reindex if indexBuilder provided
    let reindexed = false;
    if (this.indexBuilder) {
      try {
        await this.indexBuilder.incrementalUpdate([outputPath]);
        reindexed = true;
      } catch {
        // Reindex failed — continue gracefully
      }
    }

    // Transition marker to materialized
    await this.markerQueue.transition(markerId, 'materialized');

    return { markerId, outputPath, anchor, committed, reindexed };
  }
}
