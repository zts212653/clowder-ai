#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;

const backlogPath = join(repoRoot, 'docs', 'BACKLOG.md');
const roadmapPath = join(repoRoot, 'docs', 'ROADMAP.md');
const generatorPath = join(repoRoot, 'scripts', 'generate-feature-index.mjs');

function isDoneStatus(status) {
  // Strip markdown bold (**) AND leading decorations (emoji / ✅ / symbols / whitespace)
  // before testing — feature docs use **done**, closed, "✅ closed", "done ✅", etc.
  // (F180 used an emoji *prefix* "✅ closed" which broke the bare ^(done|closed) match.)
  const plain = String(status ?? '')
    .replace(/\*+/g, '')
    .replace(/^[^A-Za-z]+/, '');
  return /^(done|closed)\b/i.test(plain);
}

function parseBacklogFeatureIds(markdown) {
  const ids = new Set();
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\|\s*(F\d{3,4})\s*\|/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function loadJson(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

function resolveTruthDocPath() {
  if (existsSync(backlogPath)) {
    return { path: backlogPath, label: 'BACKLOG' };
  }

  if (existsSync(roadmapPath)) {
    return { path: roadmapPath, label: 'ROADMAP' };
  }

  throw new Error(`Missing backlog/roadmap: ${backlogPath} | ${roadmapPath}`);
}

function buildFeatureStatusMap(features) {
  const map = new Map();

  for (const feature of features) {
    const id = feature?.id;
    if (typeof id !== 'string' || !/^F\d{3,4}$/.test(id)) {
      continue;
    }

    const status = String(feature?.status ?? '');
    const entry = map.get(id) ?? { hasActive: false, hasDone: false };
    if (isDoneStatus(status)) {
      entry.hasDone = true;
    } else {
      entry.hasActive = true;
    }
    map.set(id, entry);
  }

  return map;
}

// --- Feature doc internal truth: Status line vs ## Timeline -----------------
// Catches the OBVIOUS, zero-ambiguity drift only: a feature doc whose Status
// claims work hasn't started (pre-development) while its ## Timeline already
// records a merged PR. Deliberately narrow — semantic checks (AC-claimed vs
// code-done, Phase ✅ vs actual code) stay human (merge-gate Step 7.5a).
// `in-progress` is NOT flagged: ~35 real docs legitimately sit at in-progress
// with already-merged Phases (normal multi-phase state).
const PRE_DEV_STATUSES = new Set(['spec', 'design', 'idea', 'draft', 'spike', 'proposed', 'planning', 'todo']);

function parseStatusLine(content) {
  // Same Status anchor as generate-feature-index.mjs parseStatus().
  const match = content.match(/>\s*\*\*Status\*\*:\s*([^\n<>]+)/i);
  if (!match) return null;
  // First token only — Status lines carry pipe/parenthetical context
  // ("spec (Phase E planned) | Owner: ...", "done（2026-06-22）").
  const firstToken = match[1]
    .trim()
    .toLowerCase()
    .split(/[\s（()）/／,，、|]/)[0];
  // rawStatus preserves the full text before tokenization so callers like
  // checkUserJourneyReadiness can pass it to isDoneStatus (which handles
  // emoji-prefixed formats like "✅ closed" that firstToken truncates).
  return { line: match[0], firstToken, rawStatus: match[1].trim() };
}

function timelineHasMergedPr(content) {
  // Scope strictly to the "## Timeline" section so a merged-PR mention elsewhere
  // (e.g. a Status line "merged (#2126)") can't false-positive.
  const lines = content.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^##\s+Timeline\s*$/.test(line));
  if (startIdx === -1) return false;
  const rest = lines.slice(startIdx + 1);
  const endRel = rest.findIndex((line) => /^##\s/.test(line));
  const sectionLines = endRel === -1 ? rest : rest.slice(0, endRel);
  // Row-level: the SAME line must carry both "merged" and a PR ref (#NNN). A
  // cross-row coincidence ("issue #123 opened" on one row, "Phase A merged" on
  // another) is NOT a merged PR (peer-review hardening, P1).
  // Negation guard (cloud-review P2): "PR #123 not merged" / "not yet merged" /
  // "to be merged" honestly track an OPEN PR — they carry "merged" + "#NNN" but
  // nothing landed, so they must NOT be read as a merged PR. Negation must be
  // adjacent to "merged" so "not a blocker, Phase A merged (#1)" stays a hit.
  const NEGATED_MERGE =
    /\b(?:not|never|to\s+be|to-be|will(?:\s+be)?|yet\s+to(?:\s+be)?|pending|awaiting)\s+(?:yet\s+|be\s+)?merged\b/i;
  return sectionLines.some((line) => /\bmerged\b/i.test(line) && /#\d+/.test(line) && !NEGATED_MERGE.test(line));
}

// --- User Journey readiness: active feature docs must have ## User Journey or user_journey_exempt ---
// F252 教训：session vs thread scope mismatch went undetected because user journey was never written.
// Only checks feature docs changed in the current branch (vs origin/main) to avoid breaking historical docs.
const USER_JOURNEY_HEADING = /^##\s+(?:User Journey\b|用户旅程)/m;
const USER_JOURNEY_EXEMPT = /user_journey_exempt\s*:/;

function getChangedFeatureDocs(repoRoot) {
  try {
    const diff = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD', '--', 'docs/features/'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return diff ? diff.split('\n').filter((f) => /^docs\/features\/F\d+.*\.md$/.test(f)) : [];
  } catch {
    // Not on a branch or no origin/main — skip (e.g. running on main itself)
    return [];
  }
}

// Discover feature docs referenced by the current branch name (e.g. feat/F252-story-player).
// This catches the F252 failure mode: branch changes code but never touches the feature doc,
// so getChangedFeatureDocs returns empty and the gate silently passes.
// Uses getCurrentBranch() so it works in detached HEAD mode (review worktrees).
function getBranchFeatureDocs(repoRoot) {
  const branch = getCurrentBranch(repoRoot);
  if (!branch || branch === 'HEAD') return [];

  // Extract F-numbers from branch name (feat/F252-story-player → ['252'])
  const fMatches = [...branch.matchAll(/F(\d+)/gi)];
  if (fMatches.length === 0) return [];

  const fNums = new Set(fMatches.map((m) => m[1]));
  const featuresDir = join(repoRoot, 'docs', 'features');

  try {
    return readdirSync(featuresDir)
      .filter((f) => {
        const numMatch = f.match(/^F(\d+)/);
        return numMatch && fNums.has(numMatch[1]) && f.endsWith('.md');
      })
      .map((f) => `docs/features/${f}`);
  } catch {
    return [];
  }
}

// Discover feature docs referenced in commit messages (e.g. "fix(F252): update player").
// Third discovery layer: catches branches where the name lacks an F-number but commit
// messages reference one. Together with getChangedFeatureDocs (diff) and getBranchFeatureDocs
// (branch name), this covers the standard workflow.
function getCommitFeatureDocs(repoRoot) {
  try {
    const log = execFileSync('git', ['log', 'origin/main..HEAD', '--format=%s%n%b'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!log) return [];

    const fMatches = [...log.matchAll(/F(\d+)/gi)];
    if (fMatches.length === 0) return [];

    const fNums = new Set(fMatches.map((m) => m[1]));
    const featuresDir = join(repoRoot, 'docs', 'features');

    try {
      return readdirSync(featuresDir)
        .filter((f) => {
          const numMatch = f.match(/^F(\d+)/);
          return numMatch && fNums.has(numMatch[1]) && f.endsWith('.md');
        })
        .map((f) => `docs/features/${f}`);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

// Resolve the current branch name, including in detached HEAD mode (e.g. review
// worktrees created with `git worktree add ... --detach`). Falls back to
// `git for-each-ref --points-at HEAD` to find a local branch whose tip matches.
function getCurrentBranch(repoRoot) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (branch !== 'HEAD') return branch;

    // Detached HEAD — find local AND remote-tracking branches whose tip matches HEAD.
    // Scanning refs/remotes/ too covers clean-clone/CI scenarios where the checkout is
    // `git checkout --detach origin/feat/story-player` with no local branch created.
    try {
      const refs = execFileSync(
        'git',
        ['for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'],
        { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (refs) {
        const lines = refs.split('\n').filter(Boolean);
        // Ambiguity guard: when main/master also points at HEAD, the feat branch
        // hasn't diverged yet — we can't tell which ref was checked out. Prefer
        // main to avoid false positives on main checkouts. Once the feat branch
        // diverges (gets its own commits), main won't point at the same SHA, so
        // the gate will correctly fire then.
        const hasMainLike = lines.some((l) => /\b(main|master)$/.test(l));
        if (!hasMainLike) {
          // No ambiguity — safe to return feat/* if found.
          // Local: "feat/story-player" → matches directly.
          // Remote: "origin/feat/story-player" → extract "feat/story-player".
          for (const line of lines) {
            const featMatch = line.match(/(feat\/.*)/i);
            if (featMatch) return featMatch[1];
          }
        }
        // Prefer main-like ref when present (avoid returning feat/* at lines[0]
        // which would false-positive the structural gate), else first ref.
        return lines.find((l) => /\b(main|master)$/.test(l)) || lines[0];
      }
    } catch {
      /* no refs found — return literal "HEAD" */
    }

    return branch;
  } catch {
    return null;
  }
}

function checkUserJourneyReadiness(repoRoot, _generatedFeatures, errors) {
  const changedDocs = getChangedFeatureDocs(repoRoot);
  const branchDocs = getBranchFeatureDocs(repoRoot);
  const commitDocs = getCommitFeatureDocs(repoRoot);
  // Union: check changed docs, docs referenced by branch name, AND docs referenced
  // in commit messages. Three discovery layers:
  //   1. git diff (deterministic — feature doc was touched)
  //   2. branch name (convention — feat/F252-story-player)
  //   3. commit messages (convention — "fix(F252): ...")
  const allDocs = [...new Set([...changedDocs, ...branchDocs, ...commitDocs])];

  if (allDocs.length === 0) {
    // Structural gate (R3 reviewer finding): if the branch is feat/* but NONE of the
    // three discovery layers found any feature doc, the feature-to-doc association is
    // missing entirely. This IS the F252 failure mode — a feature ships without its
    // User Journey ever being checked. Block and tell the developer how to fix it.
    // Non-feat branches (fix/, chore/, hotfix/) are unaffected.
    const branch = getCurrentBranch(repoRoot);
    if (branch && /^feat\//i.test(branch)) {
      errors.push(
        `[user-journey-undiscoverable] Feature branch "${branch}" cannot be associated with any feature doc. ` +
          'Include an F-number in the branch name (feat/F252-...), commit messages (fix(F252): ...), ' +
          'or modify the feature doc directly so the User Journey gate can verify it.',
      );
    }
    return 0;
  }

  let checked = 0;

  for (const relPath of allDocs) {
    const filePath = join(repoRoot, relPath);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');

    // Skip non-spec docs (verification reports, evidence files, dogfood reports).
    // These live alongside specs in docs/features/ but don't need User Journey.
    // Allowlist spec-like kinds; legacy docs may use "feature-spec" or "feature"
    // instead of "spec". If doc_kind is absent, default to treating as spec
    // (backward-compatible with older docs without explicit frontmatter).
    const SPEC_DOC_KINDS = ['spec', 'feature-spec', 'feature'];
    const docKindMatch = content.match(/^doc_kind:\s*(\S+)/m);
    const docTypeMatch = content.match(/^doc_type:\s*(\S+)/m);
    const docKind = docKindMatch?.[1]?.replace(/^["']|["']$/g, '')?.toLowerCase();
    const docType = docTypeMatch?.[1]?.replace(/^["']|["']$/g, '')?.toLowerCase();
    if ((docKind && !SPEC_DOC_KINDS.includes(docKind)) || (docType && docType !== 'spec')) continue;

    const status = parseStatusLine(content);

    // Skip done/closed features — they predate this gate.
    // Use rawStatus (not firstToken) so emoji-prefixed formats like "✅ closed"
    // are correctly recognized (firstToken truncates to "✅" which isDoneStatus
    // strips to empty string → false negative).
    if (status && isDoneStatus(status.rawStatus)) continue;

    checked += 1;

    const hasJourney = USER_JOURNEY_HEADING.test(content);
    const hasExempt = USER_JOURNEY_EXEMPT.test(content);

    if (!hasJourney && !hasExempt) {
      const featureMatch = relPath.match(/F(\d+)/);
      const fid = featureMatch ? `F${featureMatch[1]}` : relPath;
      errors.push(
        `[user-journey-missing] ${fid}: active feature doc lacks "## User Journey" section. Add a User Journey (scope unit + flow) or write "user_journey_exempt: {reason}" if this feature has no user-perceivable changes.`,
      );
    }
  }
  return checked;
}

function checkDocStatusDrift(repoRoot, generatedFeatures, errors) {
  const featuresDir = join(repoRoot, 'docs', 'features');
  let scanned = 0;
  // Walk only the canonical features the generated index vouches for. The index
  // already excludes verification docs (generate-feature-index isVerificationDoc),
  // so a verification report with a spec Status + merged Timeline never blocks
  // merge-gate (peer-review hardening, P2). Each index entry carries `file`.
  for (const feature of generatedFeatures) {
    if (typeof feature?.file !== 'string' || typeof feature?.id !== 'string') {
      continue;
    }
    const filePath = join(featuresDir, feature.file);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, 'utf-8');
    scanned += 1;
    const status = parseStatusLine(content);
    if (!status || !PRE_DEV_STATUSES.has(status.firstToken)) {
      continue;
    }
    // Reopen exemption (mechanical grep, not semantic judgement): a reopened
    // feature legitimately sits at "spec (next Phase)" while old Phases are merged.
    if (/reopen/i.test(status.line)) {
      continue;
    }
    if (timelineHasMergedPr(content)) {
      errors.push(
        `[doc-status-drift] ${feature.id}: Status="${status.firstToken}" (pre-development) but ## Timeline records a merged PR — doc claims work hasn't started while code is already merged. Advance Status (in-progress/done) or add a reopen marker.`,
      );
    }
  }
  return scanned;
}

function generateFreshIndex(outputPath) {
  if (!existsSync(generatorPath)) {
    throw new Error(`Missing generator script: ${generatorPath}`);
  }

  execFileSync('node', [generatorPath, '--output', outputPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function main() {
  const errors = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'cc-feature-truth-'));
  const generatedIndexPath = join(tempDir, 'index.json');

  try {
    // docs/features/index.json is a derived artifact with no live consumer:
    // the runtime builds its feature index from the docs directly and the
    // opensource sync regenerates it fresh. It is no longer committed, so we
    // regenerate it into a tempdir and validate truth from that fresh copy.
    // There is nothing to diff a committed file against — which removes the
    // merge-order staleness that only ever produced gate noise.
    generateFreshIndex(generatedIndexPath);

    const truthDoc = resolveTruthDocPath();
    const backlogMarkdown = readFileSync(truthDoc.path, 'utf-8');
    const generatedIndex = loadJson(generatedIndexPath);

    const generatedFeatures = Array.isArray(generatedIndex.features) ? generatedIndex.features : [];

    const backlogIds = parseBacklogFeatureIds(backlogMarkdown);
    const statusMap = buildFeatureStatusMap(generatedFeatures);

    for (const backlogId of backlogIds) {
      const entry = statusMap.get(backlogId);
      if (!entry) {
        errors.push(`[backlog-ref] ${truthDoc.label} contains ${backlogId}, but no such feature exists in index`);
        continue;
      }
      if (!entry.hasActive && entry.hasDone) {
        errors.push(`[backlog-active] ${truthDoc.label} contains ${backlogId}, but all records are done`);
      }
    }

    for (const [featureId, entry] of statusMap.entries()) {
      if (entry.hasActive && !backlogIds.has(featureId)) {
        errors.push(`[backlog-missing] Active feature ${featureId} is missing from ${truthDoc.label}`);
      }
    }

    const featureDocsScanned = checkDocStatusDrift(repoRoot, generatedFeatures, errors);
    const journeyDocsChecked = checkUserJourneyReadiness(repoRoot, generatedFeatures, errors);

    if (errors.length > 0) {
      console.error(`FAIL check-feature-truth: ${errors.length} issue(s) found`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    console.log(
      `PASS check-feature-truth: features=${generatedFeatures.length} ${truthDoc.label.toLowerCase()}_active=${backlogIds.size} feature_docs_scanned=${featureDocsScanned} journey_docs_checked=${journeyDocsChecked}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL check-feature-truth: ${message}`);
  process.exit(1);
}
