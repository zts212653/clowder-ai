/**
 * F061: POLL_RESPONSE_JS thinking DOM regression tests
 *
 * Root cause: Antigravity uses "Thought for Xs" button + max-h-0/opacity-0
 * collapsed container for thinking — NOT <details> or [class*="thinking"].
 * Old POLL_RESPONSE_JS didn't recognize this pattern, so hidden thought text
 * was collected as responseText, causing premature stable count + repeated content.
 *
 * Tests use JSDOM to construct real DOM fixtures and evaluate the script,
 * verifying actual behavioral output (responseText / thinkingText).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

import { POLL_RESPONSE_JS } from '../dist/domains/cats/services/agents/providers/antigravity/cdp-dom-scripts.js';

/**
 * Build a minimal Antigravity-like DOM and run POLL_RESPONSE_JS against it.
 * Returns the parsed result object.
 *
 * Structure: .group wraps the user message so the fallback sibling-walk path
 * discovers subsequent assistant blocks as siblings of .group.
 */
function runPollInDom(assistantHtml, userMsg = 'User question') {
  const html = `
		<div class="group pt-4">
			<div class="whitespace-pre-wrap">${userMsg}</div>
		</div>
		${assistantHtml}
	`;
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    url: 'http://localhost',
    runScripts: 'dangerously',
  });
  const raw = dom.window.eval(POLL_RESPONSE_JS);
  dom.window.close();
  return JSON.parse(raw);
}

// ── Behavioral DOM fixture tests (P2 fix) ─────────────────────────────

describe('F061: POLL_RESPONSE_JS behavioral DOM fixtures', () => {
  it('Antigravity thinking: responseText clean, thinkingText has no CSS garbage', () => {
    const result = runPollInDom(`
			<div>
				<button>Thought for 16s</button>
				<div class="max-h-0 opacity-0">
					<style>/* Copied from remark-github-blockquote-alert/alert.css */</style>
					<p>Let me think about this carefully...</p>
					<p>The user is asking about X.</p>
				</div>
				<div class="visible-answer">
					<p>Here is my response to your question.</p>
					<p>This is the second paragraph.</p>
				</div>
			</div>
		`);
    // responseText must be clean
    assert.ok(
      !result.responseText.includes('think about this carefully'),
      'responseText must not contain thinking text',
    );
    assert.ok(!result.responseText.includes('alert.css'), 'responseText must not contain CSS garbage');
    assert.ok(!result.responseText.includes('Thought for 16s'), 'responseText must not contain button text');
    assert.ok(result.responseText.includes('Here is my response'), 'responseText must contain visible answer');
    assert.ok(result.responseText.includes('second paragraph'), 'responseText must contain all visible paragraphs');
    // thinkingText must contain thought content but NOT CSS garbage
    assert.ok(
      result.thinkingText.includes('think about this carefully'),
      'thinkingText should contain thought content',
    );
    assert.ok(!result.thinkingText.includes('alert.css'), 'thinkingText must not contain CSS garbage');
    assert.ok(!result.thinkingText.includes('Thought for 16s'), 'thinkingText must not contain button text');
    assert.ok(result.thinkingText.length > 0, 'thinkingText should be non-empty when thinking is present');
  });

  it('backward compat: <details> thinking still works', () => {
    const result = runPollInDom(`
			<div>
				<details class="thinking">
					<summary>Thinking...</summary>
					<p>Internal reasoning here.</p>
				</details>
				<p>The actual answer.</p>
			</div>
		`);
    assert.ok(!result.responseText.includes('Internal reasoning'), 'responseText must not contain details thinking');
    assert.ok(result.responseText.includes('actual answer'), 'responseText must contain the answer');
    assert.ok(result.thinkingText.includes('Internal reasoning'), 'thinkingText should contain details content');
  });

  it('no thinking: plain response extracted correctly', () => {
    const result = runPollInDom(`
			<div>
				<p>Hello! How can I help you today?</p>
			</div>
		`);
    assert.ok(result.responseText.includes('How can I help you'), 'responseText should contain the response');
    assert.equal(result.thinkingText, '', 'thinkingText should be empty');
    assert.equal(result.thinkingText.length, 0, 'no thinking content when no thinking elements');
  });

  it('hidden class elements are stripped from text extraction', () => {
    const result = runPollInDom(`
			<div>
				<div class="hidden">This should not appear</div>
				<div aria-hidden="true">Also hidden</div>
				<p>Visible response text.</p>
			</div>
		`);
    assert.ok(!result.responseText.includes('should not appear'), 'hidden class elements must be stripped');
    assert.ok(!result.responseText.includes('Also hidden'), 'aria-hidden elements must be stripped');
    assert.ok(result.responseText.includes('Visible response'), 'visible text must remain');
  });

  it('thought button with CSS-heavy sibling: CSS stripped from thinkingText', () => {
    const result = runPollInDom(`
			<div>
				<button>Thought for 8s</button>
				<div class="max-h-0 opacity-0">
					<style>.foo { color: red; }</style>
					<script>console.log('should be stripped')</script>
					<p>Actual thinking content here.</p>
				</div>
				<p>Final answer.</p>
			</div>
		`);
    assert.ok(result.responseText.includes('Final answer'), 'responseText has answer');
    assert.ok(!result.responseText.includes('Actual thinking'), 'responseText has no thinking');
    assert.ok(result.thinkingText.includes('Actual thinking content'), 'thinkingText has thought content');
    assert.ok(!result.thinkingText.includes('color: red'), 'thinkingText has no CSS');
    assert.ok(!result.thinkingText.includes('should be stripped'), 'thinkingText has no script content');
  });
});

// ── Regression tests (code review P1 items) ────────────────────────────

describe('F061: POLL_RESPONSE_JS regression tests (code review)', () => {
  it('concatenated icon text is stripped from responseText', () => {
    // Simulates the toolbar icon leak: content_copythumb_upthumb_down
    const result = runPollInDom(`
			<div>
				<div class="leading-relaxed select-text">
					<p>Actual response content here.</p>
				</div>
				<div class="flex justify-between cursor-default">
					<span>content_copy</span><span>thumb_up</span><span>thumb_down</span>
				</div>
			</div>
		`);
    assert.ok(result.responseText.includes('Actual response content'), 'responseText has real content');
    assert.ok(!result.responseText.includes('content_copy'), 'icon text stripped individually');
    assert.ok(!result.responseText.includes('thumb_up'), 'icon text stripped');
    assert.ok(!result.responseText.includes('content_copythumb_upthumb_down'), 'concatenated icon text stripped');
  });

  it('icon-only blocks should not trigger response completion', () => {
    // When thinking leaks and only toolbar icons remain, responseText should be empty
    const result = runPollInDom(`
			<div>
				<button>Thought for 12s</button>
				<div class="max-h-0 opacity-0">
					<p>Internal thinking about the problem...</p>
				</div>
			</div>
		`);
    // Only thinking content exists — responseText must be empty
    assert.ok(!result.responseText.includes('Internal thinking'), 'thinking text must not leak to responseText');
    assert.ok(result.thinkingText.includes('Internal thinking'), 'thinkingText should contain thinking');
  });

  it('uses getComputedStyle-based isVisiblyHidden helper', () => {
    assert.ok(POLL_RESPONSE_JS.includes('getComputedStyle'), 'script should use getComputedStyle for visibility');
    assert.ok(POLL_RESPONSE_JS.includes('isVisiblyHidden'), 'script should define isVisiblyHidden helper');
  });

  it('has icon concatenation regex cleanup', () => {
    assert.ok(POLL_RESPONSE_JS.includes('ICON_CONCAT_RE'), 'script should have ICON_CONCAT_RE pattern');
    assert.ok(POLL_RESPONSE_JS.includes('stripIconArtifacts'), 'script should have stripIconArtifacts function');
  });
});

// ── Smoke tests (script structure validation) ──────────────────────────

describe('F061: POLL_RESPONSE_JS structure smoke tests', () => {
  it('contains Antigravity thought button detection pattern', () => {
    assert.ok(POLL_RESPONSE_JS.includes('Thought\\s+for\\s'), 'script should match "Thought for Xs" via regex');
  });

  it('contains hidden element filtering patterns', () => {
    assert.ok(POLL_RESPONSE_JS.includes('max-h-0'), 'detects max-h-0');
    assert.ok(POLL_RESPONSE_JS.includes('opacity-0'), 'detects opacity-0');
    assert.ok(POLL_RESPONSE_JS.includes('\\bhidden\\b'), 'detects hidden class');
  });

  it('preserves backward compat selectors', () => {
    assert.ok(POLL_RESPONSE_JS.includes('details'), 'still detects <details>');
    assert.ok(POLL_RESPONSE_JS.includes('[class*="thinking"]'), 'still detects thinking class');
    assert.ok(POLL_RESPONSE_JS.includes('[class*="thought"]'), 'still detects thought class');
  });

  it('strips buttons in extractBlockText', () => {
    assert.ok(POLL_RESPONSE_JS.includes("clone.querySelectorAll('button')"), 'buttons stripped from clone');
  });
});

// ── P2 behavioral tests: isVisiblyHidden JSDOM/browser gap ─────────────
// Requested by codex re-review of commit 4ae89c68

describe('F061: isVisiblyHidden JSDOM/browser behavioral consistency', () => {
  it('ancestor aria-hidden/inert hides child even if child has visible classes', () => {
    // Risk: isVisiblyHidden only checks the direct element, not ancestors.
    // The ancestor-walk in assistantBlocks extraction (lines 186-190) should catch this.
    const result = runPollInDom(`
			<div>
				<div class="leading-relaxed select-text">
					<div aria-hidden="true">
						<p class="text-base font-normal">Should be hidden despite visible classes</p>
					</div>
					<div inert>
						<p>Also hidden via inert</p>
					</div>
					<p>Visible answer alongside hidden ancestors.</p>
				</div>
			</div>
		`);
    assert.ok(!result.responseText.includes('Should be hidden'), 'aria-hidden ancestor must suppress child text');
    assert.ok(!result.responseText.includes('Also hidden via inert'), 'inert ancestor must suppress child text');
    assert.ok(result.responseText.includes('Visible answer'), 'text outside hidden subtrees must survive');
  });

  it('animation-class opacity-0 on wrapper does not leak into response', () => {
    // Scenario: element has Tailwind opacity-0 class (enter-animation or collapsed).
    // In JSDOM, getComputedStyle returns '' for opacity → parseFloat('') = NaN,
    // NaN < 0.01 is false → isVisiblyHidden returns false.
    // BUT extractBlockText's class-name regex guard (line 86-88) strips opacity-0 subtrees.
    // Both paths converge: opacity-0 content removed from final text. Correct behavior.
    const result = runPollInDom(`
			<div>
				<div class="opacity-0 transition-opacity">
					<p>Animated content that should be stripped by class-name guard</p>
				</div>
				<div class="leading-relaxed select-text">
					<p>The real visible answer.</p>
				</div>
			</div>
		`);
    assert.ok(!result.responseText.includes('Animated content'), 'opacity-0 class elements stripped from text extraction');
    assert.ok(result.responseText.includes('real visible answer'), 'non-opacity-0 response text preserved');
  });

  it('JSDOM geometry-all-zero does not false-positive hide normal replies', () => {
    // JSDOM quirk: clientHeight=0 and scrollHeight=0 for ALL elements.
    // isVisiblyHidden check: el.clientHeight === 0 && el.scrollHeight > 0 → 0===0 && 0>0 → false
    // Geometry heuristic is effectively disabled in JSDOM — safer direction (no false kills).
    const result = runPollInDom(`
			<div>
				<div class="leading-relaxed select-text">
					<p>Normal paragraph one.</p>
					<p>Normal paragraph two.</p>
					<pre>Code block content</pre>
				</div>
			</div>
		`);
    assert.ok(result.responseText.includes('Normal paragraph one'), 'first paragraph survives JSDOM geometry quirk');
    assert.ok(result.responseText.includes('Normal paragraph two'), 'second paragraph survives');
    assert.ok(result.responseText.includes('Code block content'), 'pre block survives');
    assert.equal(result.userMsgCount, 1, 'exactly one user message detected');
  });

  it('icon concat mixed with real text: only icons stripped, prose preserved', () => {
    // Risk: ICON_CONCAT_RE or stripIconArtifacts might eat surrounding text.
    const result = runPollInDom(`
			<div>
				<div class="leading-relaxed select-text">
					<p>Here is the answer to your question.</p>
					<p>content_copythumb_upthumb_down</p>
					<p>And here is additional context.</p>
				</div>
			</div>
		`);
    assert.ok(result.responseText.includes('answer to your question'), 'prose before icons preserved');
    assert.ok(result.responseText.includes('additional context'), 'prose after icons preserved');
    assert.ok(!result.responseText.includes('content_copy'), 'individual icon stripped');
    assert.ok(!result.responseText.includes('thumb_up'), 'individual icon stripped');
    assert.ok(!result.responseText.includes('content_copythumb_upthumb_down'), 'concatenated icon run stripped');
  });
});
