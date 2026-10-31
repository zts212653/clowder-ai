import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { developmentPlanRefSchema, developmentRevisionSchema } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type DevelopmentScopeDocuments, DevelopmentScopeUnavailable } from './DevelopmentScopeResolver.js';

const run = promisify(execFile);
const featureMetadata = z.object({
  doc_kind: z.string().optional(),
  doc_type: z.string().optional(),
  feature_ids: z.union([z.array(z.string()), z.string()]).optional(),
});

function isFeatureSourceCandidate(content: string, featureId: string): boolean {
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return !/^\uFEFF?---\r?\n/.test(content);
  try {
    const parsed: unknown = parseYaml(frontmatter, { maxAliasCount: 0 });
    const metadata = featureMetadata.safeParse(parsed);
    if (!metadata.success) return false;
    const { doc_kind: kind, doc_type: type, feature_ids: ids } = metadata.data;
    // Keep the repository's legacy note/done/vision Feature sources addressable.
    // Classifying a source is not authorization to resume its historical work.
    if (kind && !['spec', 'feature-spec', 'feature', 'note', 'done', 'vision'].includes(kind.toLowerCase()))
      return false;
    if (type && type.toLowerCase() !== 'spec') return false;
    return ids === undefined || (Array.isArray(ids) ? ids.includes(featureId) : ids === featureId);
  } catch {
    return false;
  }
}
/** Read exact committed owner documents; no network fetch, workspace fallback, or caller-selected root. */
export class DevelopmentScopeGitDocuments implements DevelopmentScopeDocuments {
  constructor(
    private readonly projectRoot: string,
    private readonly executeGit?: (args: string[]) => Promise<string>,
  ) {}

  private async git(args: string[]): Promise<string> {
    try {
      if (this.executeGit) return await this.executeGit(args);
      const result = await run('git', args, {
        cwd: this.projectRoot,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      return result.stdout;
    } catch (cause) {
      throw new DevelopmentScopeUnavailable('Accepted source cannot currently be verified', { cause });
    }
  }

  async readFeature(featureId: string, revision: string): Promise<{ ref: string; content: string } | null> {
    if (!/^F\d+$/.test(featureId) || !developmentRevisionSchema.safeParse(revision).success) return null;
    const list = await this.git(['ls-tree', '-r', '--name-only', revision, '--', 'docs/features/']);
    const files = list
      .split('\n')
      .filter((file) => new RegExp(`^docs/features/${featureId}-[A-Za-z0-9_-]+\\.md$`).test(file));
    const candidates: Array<{ ref: string; content: string }> = [];
    for (const path of files) {
      const content = await this.git(['show', `${revision}:${path}`]);
      if (isFeatureSourceCandidate(content, featureId)) candidates.push({ ref: `file:${path}`, content });
    }
    const candidate = candidates[0];
    if (candidates.length !== 1 || !candidate) return null;
    return candidate;
  }

  async readPlan(ref: string, revision: string): Promise<string | null> {
    if (!developmentPlanRefSchema.safeParse(ref).success || !developmentRevisionSchema.safeParse(revision).success)
      return null;
    const path = ref.slice('file:'.length, ref.indexOf('#'));
    // A successful tree lookup proves absence; command failures remain unverifiable.
    const listing = await this.git(['ls-tree', '--name-only', revision, '--', path]);
    if (!listing.trim()) return null;
    return this.git(['show', `${revision}:${path}`]);
  }
}
