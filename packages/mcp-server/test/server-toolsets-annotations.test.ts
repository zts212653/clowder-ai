import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildAudioTools,
  buildCollabTools,
  buildFinanceTools,
  buildLimbTools,
  buildMemoryTools,
  buildSignalTools,
  EXPLICIT_TOOL_ANNOTATIONS,
} from '../src/server-toolsets.js';

/**
 * F247 R8 P1-1 regression: explicit MCP tool annotation table guard.
 *
 * 砚砚 R8 finding (2026-06-22): early `inferAnnotations()` used prefix heuristics that
 * mis-bucketed 7 mutating tools as read-only (workspace_navigate / preview_open /
 * signal_summarize / generate_document / bootcamp_env_check / review_distillation
 * all callbackPost mutate the Hub backend) and bucketed library_dry_run as destructive
 * despite its non-persisting contract.
 *
 * This file locks in the corrected explicit table so a future refactor can't silently
 * regress annotation semantics — `cross-cutting metadata that ChatGPT consumes`.
 */

describe('F247 R8 P1-1: EXPLICIT_TOOL_ANNOTATIONS regression guard', () => {
  describe('cloud-pro-phase0 10 whitelist (砚砚 ChatGPT 端实测 surface)', () => {
    const cloudProPhase0Whitelist = [
      // 5 collab
      'cat_cafe_post_message',
      'cat_cafe_cross_post_message',
      'cat_cafe_get_thread_context',
      'cat_cafe_get_message',
      'cat_cafe_list_threads',
      // 5 memory
      'cat_cafe_search_evidence',
      'cat_cafe_graph_resolve',
      'cat_cafe_list_recent',
      'cat_cafe_list_session_chain',
      'cat_cafe_read_session_digest',
    ];

    for (const name of cloudProPhase0Whitelist) {
      it(`${name} has explicit annotation`, () => {
        assert.ok(EXPLICIT_TOOL_ANNOTATIONS[name], `${name} must be in explicit table`);
        const ann = EXPLICIT_TOOL_ANNOTATIONS[name];
        assert.equal(typeof ann.readOnlyHint, 'boolean');
        assert.equal(typeof ann.destructiveHint, 'boolean');
        assert.equal(typeof ann.openWorldHint, 'boolean');
      });
    }

    it('read tools (8/10) all have readOnlyHint=true', () => {
      const reads = [
        'cat_cafe_get_thread_context',
        'cat_cafe_get_message',
        'cat_cafe_list_threads',
        'cat_cafe_search_evidence',
        'cat_cafe_graph_resolve',
        'cat_cafe_list_recent',
        'cat_cafe_list_session_chain',
        'cat_cafe_read_session_digest',
      ];
      for (const r of reads) {
        assert.equal(EXPLICIT_TOOL_ANNOTATIONS[r].readOnlyHint, true, `${r} must be readOnlyHint=true`);
        assert.equal(EXPLICIT_TOOL_ANNOTATIONS[r].destructiveHint, false, `${r} read tool must not be destructive`);
      }
    });

    it('write tools (2/10) are non-destructive', () => {
      for (const w of ['cat_cafe_post_message', 'cat_cafe_cross_post_message']) {
        assert.equal(EXPLICIT_TOOL_ANNOTATIONS[w].readOnlyHint, false);
        assert.equal(EXPLICIT_TOOL_ANNOTATIONS[w].destructiveHint, false);
      }
    });

    it('search_evidence is openWorld (hits remote knowledge stores)', () => {
      assert.equal(EXPLICIT_TOOL_ANNOTATIONS.cat_cafe_search_evidence.openWorldHint, true);
    });

    it('read tools NOT hitting remote are openWorld=false', () => {
      for (const r of [
        'cat_cafe_graph_resolve',
        'cat_cafe_list_recent',
        'cat_cafe_list_threads',
        'cat_cafe_read_session_digest',
      ]) {
        assert.equal(EXPLICIT_TOOL_ANNOTATIONS[r].openWorldHint, false, `${r} should not be openWorld`);
      }
    });
  });

  describe('R8 P1-1 regression: 7 previously misclassified tools (no silent regression)', () => {
    const mutatingToolsMisclassifiedBefore = [
      // Were prefix-matched into read-only branch, must now be write
      'cat_cafe_workspace_navigate',
      'cat_cafe_preview_open',
      'signal_summarize',
      'cat_cafe_generate_document',
      'cat_cafe_bootcamp_env_check',
      'cat_cafe_review_distillation',
    ];

    for (const name of mutatingToolsMisclassifiedBefore) {
      it(`${name} is NOT marked read-only (write tool with side effects)`, () => {
        const ann = EXPLICIT_TOOL_ANNOTATIONS[name];
        assert.ok(ann, `${name} must be in explicit table`);
        assert.equal(
          ann.readOnlyHint,
          false,
          `${name} is write/mutating per source code review — must not be readOnlyHint=true`,
        );
        assert.equal(ann.destructiveHint, false, `${name} is non-destructive write — must not be destructiveHint=true`);
      });
    }

    it('library_dry_run is read-only (non-persisting per its contract)', () => {
      const ann = EXPLICIT_TOOL_ANNOTATIONS.cat_cafe_library_dry_run;
      assert.ok(ann);
      assert.equal(ann.readOnlyHint, true, 'library_dry_run does not persist');
      assert.equal(ann.destructiveHint, false, 'library_dry_run is not destructive');
    });
  });

  describe('destructive tool flagging (must require user confirm in ChatGPT)', () => {
    const destructiveTools = [
      'cat_cafe_shell_exec',
      'cat_cafe_library_archive',
      'cat_cafe_library_rebuild',
      'signal_delete_article',
      // R8.2 砚砚 finding: remove/unregister/unlink tools must be destructive
      'cat_cafe_remove_scheduled_task', // "stops the task and deletes it permanently"
      'cat_cafe_unregister_tracking', // stops all automated PR/CI/issue notifications, deletes association
      'signal_link_thread', // action=unlink branch DELETEs association (max-risk path)
    ];

    for (const name of destructiveTools) {
      it(`${name} has destructiveHint=true`, () => {
        const ann = EXPLICIT_TOOL_ANNOTATIONS[name];
        assert.ok(ann, `${name} must be in explicit table`);
        assert.equal(ann.destructiveHint, true, `${name} causes irreversible data loss — must be destructiveHint=true`);
        assert.equal(ann.readOnlyHint, false, `${name} destructive cannot be read-only`);
      });
    }
  });

  describe('R8.2: explicit table covers ALL registered tools (no silent fallback)', () => {
    /**
     * 砚砚 R8.2 review extra build: pin the table 1:1 against actually-registered tools.
     * Future new tool will fall through to `A_WRITE_SAFE` (most conservative) silently
     * without surfacing in code review. This test forces every new tool to be added
     * explicitly to EXPLICIT_TOOL_ANNOTATIONS.
     */

    const registeredToolNames = new Set<string>([
      ...buildCollabTools().map((t) => t.name),
      ...buildMemoryTools().map((t) => t.name),
      ...buildSignalTools().map((t) => t.name),
      ...buildLimbTools().map((t) => t.name),
      ...buildAudioTools().map((t) => t.name),
      ...buildFinanceTools().map((t) => t.name),
    ]);

    it('every registered tool has an explicit annotation entry', () => {
      const missing: string[] = [];
      for (const name of registeredToolNames) {
        if (!EXPLICIT_TOOL_ANNOTATIONS[name]) missing.push(name);
      }
      assert.deepEqual(
        missing,
        [],
        `${missing.length} tool(s) missing explicit annotation — add them to EXPLICIT_TOOL_ANNOTATIONS rather than relying on A_WRITE_SAFE fallback: ${missing.join(', ')}`,
      );
    });

    it('no entry in EXPLICIT_TOOL_ANNOTATIONS is dead (referencing a removed tool)', () => {
      const extra: string[] = [];
      for (const name of Object.keys(EXPLICIT_TOOL_ANNOTATIONS)) {
        if (!registeredToolNames.has(name)) extra.push(name);
      }
      assert.deepEqual(
        extra,
        [],
        `${extra.length} explicit annotation entry has no registered tool — clean up: ${extra.join(', ')}`,
      );
    });
  });

  describe('schema invariants', () => {
    it('every entry has exactly 3 keys with boolean values', () => {
      for (const [name, ann] of Object.entries(EXPLICIT_TOOL_ANNOTATIONS)) {
        const keys = Object.keys(ann).sort();
        assert.deepEqual(
          keys,
          ['destructiveHint', 'openWorldHint', 'readOnlyHint'],
          `${name} must have exactly the 3 annotation keys`,
        );
        for (const k of keys) {
          assert.equal(typeof ann[k as keyof typeof ann], 'boolean', `${name}.${k} must be boolean`);
        }
      }
    });

    it('read-only tool cannot be destructive (invariant)', () => {
      for (const [name, ann] of Object.entries(EXPLICIT_TOOL_ANNOTATIONS)) {
        if (ann.readOnlyHint) {
          assert.equal(ann.destructiveHint, false, `${name}: readOnlyHint=true implies destructiveHint=false`);
        }
      }
    });
  });
});
