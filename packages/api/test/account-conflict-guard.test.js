import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('account conflict detection guard (HC-5)', () => {
  let globalRoot;
  let previousGlobalRoot;

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'acct-conflict-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  });

  async function writeKnownRoots(roots) {
    const dir = join(globalRoot, '.cat-cafe');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'known-project-roots.json'), JSON.stringify(roots), 'utf-8');
  }

  async function writeCatalogWithAccounts(projectRoot, accounts) {
    const dir = join(projectRoot, '.cat-cafe');
    await mkdir(dir, { recursive: true });
    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {
        requireDifferentFamily: true,
        preferActiveInThread: true,
        preferLead: true,
        excludeUnavailable: true,
      },
      accounts,
    };
    await writeFile(join(dir, 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');
  }

  it('no conflict when same accountRef has identical config across projects', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      const sameAccount = { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.example.com/v1' };
      await writeCatalogWithAccounts(projectA, { shared: sameAccount });
      await writeCatalogWithAccounts(projectB, { shared: sameAccount });

      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 0);
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('detects conflict when same accountRef has different protocol', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-1`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectA, {
        myacct: { authType: 'api_key', protocol: 'openai' },
      });
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'anthropic' },
      });

      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].accountRef, 'myacct');
      assert.ok(conflicts[0].details.includes('protocol'));
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('detects conflict when same accountRef has different authType', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-2`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectA, {
        myacct: { authType: 'oauth', protocol: 'openai' },
      });
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'openai' },
      });

      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].details.includes('authType'));
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('normalizes baseUrl trailing slash before comparison (HC-5 gpt52)', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-3`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectA, {
        myacct: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
      });
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.openai.com/v1/' },
      });

      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 0, 'trailing slash difference should not be a conflict');
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('detects conflict when baseUrl is genuinely different', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-4`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectA, {
        myacct: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
      });
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://other.api.com/v1' },
      });

      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].details.includes('baseUrl'));
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('returns empty when no known roots file exists', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-5`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    try {
      await writeCatalogWithAccounts(projectA, {
        myacct: { authType: 'api_key', protocol: 'openai' },
      });
      const conflicts = detectAccountConflicts(projectA);
      assert.equal(conflicts.length, 0);
    } finally {
      await rm(projectA, { recursive: true, force: true });
    }
  });

  it('validateAccountWrite reuses same conflict logic (write-path guard)', async () => {
    const { validateAccountWrite } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-6`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'anthropic' },
      });

      // Attempting to write 'myacct' with protocol: 'openai' in projectA should error
      assert.throws(
        () => validateAccountWrite(projectA, 'myacct', { authType: 'api_key', protocol: 'openai' }),
        (err) => err.message.includes('myacct') && err.message.includes('protocol'),
      );
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('validateAccountWrite allows write when no conflict', async () => {
    const { validateAccountWrite } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-7`);
    const projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));

    try {
      await writeKnownRoots([projectA, projectB]);
      await writeCatalogWithAccounts(projectB, {
        myacct: { authType: 'api_key', protocol: 'openai' },
      });

      // Same config should not throw
      assert.doesNotThrow(() => validateAccountWrite(projectA, 'myacct', { authType: 'api_key', protocol: 'openai' }));
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  /** Helper: set up two dirs as main repo + worktree of the same git project. */
  async function setupWorktreePair() {
    const mainRepo = await mkdtemp(join(tmpdir(), 'main-repo-'));
    const worktree = await mkdtemp(join(tmpdir(), 'worktree-'));
    // Main repo: .git/ directory
    const gitDir = join(mainRepo, '.git');
    await mkdir(gitDir, { recursive: true });
    // Worktree: .git file pointing to main repo's .git/worktrees/<name>
    const wtName = 'wt-runtime';
    const worktreesDir = join(gitDir, 'worktrees', wtName);
    await mkdir(worktreesDir, { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${worktreesDir}\n`, 'utf-8');
    return {
      mainRepo,
      worktree,
      cleanup: () =>
        Promise.all([rm(mainRepo, { recursive: true, force: true }), rm(worktree, { recursive: true, force: true })]),
    };
  }

  it('detectAccountConflicts ignores worktrees of the same git project', async () => {
    const { detectAccountConflicts } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-wt1`);
    const { mainRepo, worktree, cleanup } = await setupWorktreePair();

    try {
      await writeKnownRoots([mainRepo, worktree]);
      await writeCatalogWithAccounts(mainRepo, {
        minimax: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1' },
      });
      await writeCatalogWithAccounts(worktree, {
        minimax: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.minimax.io/v11' },
      });

      const conflicts = detectAccountConflicts(mainRepo);
      assert.equal(conflicts.length, 0, 'worktrees of the same project should not trigger conflict');
    } finally {
      await cleanup();
    }
  });

  it('validateAccountWrite allows update when conflict is from a worktree of the same project', async () => {
    const { validateAccountWrite } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-wt2`);
    const { mainRepo, worktree, cleanup } = await setupWorktreePair();

    try {
      await writeKnownRoots([mainRepo, worktree]);
      // Main repo has old baseUrl
      await writeCatalogWithAccounts(mainRepo, {
        minimax: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1' },
      });

      // Writing updated baseUrl from worktree should NOT throw
      assert.doesNotThrow(() =>
        validateAccountWrite(worktree, 'minimax', {
          authType: 'api_key',
          protocol: 'openai',
          baseUrl: 'https://api.minimax.io/v11',
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it('still detects conflict between genuinely different projects (not worktrees)', async () => {
    const { validateAccountWrite } = await import(`../dist/config/account-conflict-guard.js?t=${Date.now()}-wt3`);
    const { mainRepo, worktree, cleanup } = await setupWorktreePair();
    const unrelatedProject = await mkdtemp(join(tmpdir(), 'unrelated-'));
    // Give unrelated project its own .git dir
    await mkdir(join(unrelatedProject, '.git'), { recursive: true });

    try {
      await writeKnownRoots([mainRepo, worktree, unrelatedProject]);
      await writeCatalogWithAccounts(unrelatedProject, {
        minimax: { authType: 'api_key', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1' },
      });

      // Writing different baseUrl from worktree SHOULD throw — unrelated project has conflicting config
      assert.throws(
        () =>
          validateAccountWrite(worktree, 'minimax', {
            authType: 'api_key',
            protocol: 'openai',
            baseUrl: 'https://api.minimax.io/v11',
          }),
        (err) => err.message.includes('minimax') && err.message.includes('baseUrl'),
      );
    } finally {
      await cleanup();
      await rm(unrelatedProject, { recursive: true, force: true });
    }
  });
});
