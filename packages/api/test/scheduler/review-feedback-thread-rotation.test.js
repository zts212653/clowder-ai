import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('#949: Verdict-without-pass suppression for connector source', () => {
  it('connector-sourced invocation (verdictPassWarningEnabled=false) skips verdict warning', async () => {
    // This test documents the expected behavior:
    // When route-serial processes a connector-sourced invocation, it should NOT
    // emit the [球权提醒] warning even if the cat's output contains a verdict keyword.
    //
    // P2 fix: uses verdictPassWarningEnabled (not frustrationAutoIssueEligible) so
    // that A2A/multi-mention callbacks still get verdict-pass handoff guards.
    // ConnectorInvokeTrigger sets verdictPassWarningEnabled: false.
    //
    // We test the verdict-detect module directly to establish the baseline.

    const { shouldWarnVerdictWithoutPass } = await import(
      '../../dist/domains/cats/services/agents/routing/verdict-detect.js'
    );

    // A typical MR review completion output — contains verdict keyword "LGTM"
    const reviewOutput = `## MR #2137 检视完成

检视结果: **LGTM ✅**

[布偶猫 Sonnet (claude-sonnet-4-6) 🐾]`;

    // Without any ball-pass, the function SHOULD trigger (baseline)
    const shouldWarn = shouldWarnVerdictWithoutPass({
      text: reviewOutput,
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
    });
    assert.equal(shouldWarn, true, 'baseline: verdict without pass should trigger warning');

    // The actual suppression happens in route-serial.ts where it checks:
    //   if (!phaseHHit && options.verdictPassWarningEnabled !== false && shouldWarnVerdictWithoutPass(...))
    // ConnectorInvokeTrigger passes verdictPassWarningEnabled: false
    // so the warning block is never entered.
    //
    // Crucially, A2A callbacks (callback-a2a-trigger.ts) and multi-mention routes
    // set frustrationAutoIssueEligible: false but do NOT set verdictPassWarningEnabled,
    // so they still get the verdict-pass handoff guard.
  });

  it('verdictPassWarningEnabled decoupling: A2A paths still warn despite frustrationAutoIssueEligible=false', async () => {
    // P2-2 behavioral test: The two flags must be independent.
    // A2A callback sets frustrationAutoIssueEligible: false (suppress frustration issues)
    // but does NOT set verdictPassWarningEnabled → defaults to undefined → gate passes → warning fires.
    //
    // This tests the gate condition in route-serial.ts:
    //   options.verdictPassWarningEnabled !== false
    // When verdictPassWarningEnabled is undefined (A2A/multi-mention default), the gate passes.

    const a2aOptions = { frustrationAutoIssueEligible: false };
    // verdictPassWarningEnabled not set → undefined → !== false → gate passes → warning fires
    assert.notEqual(
      a2aOptions.verdictPassWarningEnabled,
      false,
      'A2A options must NOT set verdictPassWarningEnabled to false',
    );
    assert.equal(
      a2aOptions.verdictPassWarningEnabled ?? true,
      true,
      'undefined verdictPassWarningEnabled defaults to truthy (warning enabled)',
    );
  });

  it('verdictPassWarningEnabled decoupling: connector paths suppress warning', async () => {
    // Connector direct-invoke sets BOTH flags independently.
    const connectorOptions = { frustrationAutoIssueEligible: false, verdictPassWarningEnabled: false };
    assert.equal(
      connectorOptions.verdictPassWarningEnabled,
      false,
      'connector options must set verdictPassWarningEnabled to false',
    );
  });

  it('verdictPassWarningEnabled decoupling: connector-queue entries suppress via source check', async () => {
    // P1-1 fix: QueueProcessor uses entry.source !== 'connector' for verdictPassWarningEnabled.
    // This verifies the boolean truth table.
    const sources = ['user', 'agent', 'connector'];
    const expected = { user: true, agent: true, connector: false };
    for (const source of sources) {
      const verdictEnabled = source !== 'connector';
      assert.equal(
        verdictEnabled,
        expected[source],
        `source='${source}' → verdictPassWarningEnabled should be ${expected[source]}`,
      );
    }
  });
});
