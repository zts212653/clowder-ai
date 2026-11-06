---
title: PR 1887 native macOS input-method observations
date: 2026-11-06
source_pr: https://github.com/zts212653/clowder-ai/pull/1887
source_head: bffff6ba3cffd354171172aa6f366ea4a5a1db95
status: maintainer evidence; no formal code approval
---

# Native macOS input-method observations for PR #1887

Tester: Sol, gpt-6.1-sol. Environment: macOS 26.2 (25C56), Apple Pinyin – Simplified, headed Chromium 149.0.7827.55.

Fixed source: `bffff6ba3cffd354171172aa6f366ea4a5a1db95`. Entry: the PR's `packages/web/test/browser/issue1863-preview.mjs`, using the production ChatInput in v2 presentation. The host replaces the API/submission boundary; this is **component-host native IME evidence**, not a full API/Redis journey, Electron result, Windows result, or code approval.

## Method

Each case starts from `https://example.com/abCD 说明`. Baseline text and caret/selection are set up in the component; the actual `zhongwen` keystrokes, Space candidate selection, Escape, Cmd+Z and Cmd+Shift+Z are macOS native keyboard events via `CGEventPost(kCGSessionEventTap)` with the owned test browser required to be foreground. The enabled Apple input source is selected through Text Input Source Services. This is an automated native-OS test, not a person typing by hand. No paste of Chinese, DOM composition dispatch, `Input.imeSetComposition`, or CDP Chinese insertion is used.

The cropped native window screenshot includes the real system candidate window. During composition the mirror is inactive and the original textarea text is visible; after confirmation/cancellation the marker follows the current source text. Raw event flags are preserved: composition start/update and input events are trusted; the observed composition-end event reports `isTrusted=false`. We do not rewrite that flag or infer its cause.

## Observed final text and selection

Selection positions are UTF-16 offsets. `mirrorActive` is the production overlay state; the submitted/source text is recorded separately in the raw report.

| Case | Final text | selectionStart / selectionEnd | mirrorActive |
| --- | --- | --- | --- |
| tail-confirm | `https://example.com/abCD中文 说明` | 26 / 26 | true |
| middle-confirm | `https://example.com/ab中文CD 说明` | 24 / 24 | true |
| tail-cancel | `https://example.com/abCD 说明` | 24 / 24 | true |
| middle-cancel | `https://example.com/abCD 说明` | 22 / 22 | true |
| replace | `中文 说明` | 2 / 2 | false |
| undoStates step 1 | `https://example.com/abCD 说明` | 0 / 9 | true |
| redoStates step 1 | `中文 说明` | 2 / 2 | false |

The five confirm/cancel/replacement cases match the requested final text, insertion point, and full marked link range. Replacement removes the URL marker. Native undo and redo each used one edit group and restored the expected full text and marker state. Undo restored selection `0 / 9`; the classic ChatInput was independently driven through the same six native cases and produced the same undo/redo text, edit groups and selections. This records the actual native grouping; it does not claim undo returns a collapsed caret.

## Raw evidence

- [System candidate window](native-candidate-window.png).
- [URL replaced by the confirmed Chinese candidate](native-selection-replace.png).
- [Complete v2 text, selections, ranges and native event observations](v2-native-results.json).
- [Classic ChatInput control with the same six native cases](classic-native-results.json).

All visible text is synthetic test input. The browser uses an isolated disposable profile; the test closes its own browser and preview and restores the original input source, pointer and foreground application. No production data, models, existing user browser profile, or author branch is used or changed.

Windows native IME remains unverified. Final acceptance still needs the outstanding device evidence and substantive code review.

[小太阳·砚砚/gpt-6.1-sol🐾]
