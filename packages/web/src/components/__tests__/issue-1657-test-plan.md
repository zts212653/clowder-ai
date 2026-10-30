# Issue #1657 Test Plan

## Required Test Coverage

### 1. Edit + Immediate Send (<400ms)

**Scenario**: User edits text and sends before autosave completes (within 400ms debounce window)

**Test Cases**:
- Text replacement: "review" → "inspect"
- Text deletion: "review PR and CI" → "review PR"  
- Text insertion: "review current PR" → "review the current PR"

**Expected**: 
- First send succeeds without confirmation prompt
- Saved draft equals edited text
- Final payload equals edited text
- No old text is merged back

### 2. Edit + Wait + Send (>400ms)

**Scenario**: User edits text, waits for autosave to complete, then sends

**Expected**: Same as immediate send (no false positive)

### 3. Delayed Hydration Recovery

**Scenario**: User clicks send while hydration is still in progress, then different remote content arrives

**Setup**:
- Local attempted: "local message"
- Remote canonical (arriving after click): "remote unsent draft"

**Expected**:
- First send does NOT succeed
- Merged snapshot displayed: "remote unsent draft\n\nlocal message"
- User sees confirmation prompt
- Second send succeeds with merged content

### 4. Image Deletion

**Scenario**: User has recovered draft with image, deletes image, sends immediately

**Expected**:
- No `ComposerDraftRecoveryBlockedError`
- Send succeeds
- Payload has no images

### 5. Context Attachment / Reply Deletion

**Scenario**: User has draft with quote/reply, removes it, sends immediately

**Expected**:
- No false recovery
- Send succeeds
- Payload reflects deletion

### 6. Confirmation Display

**Scenario**: Legitimate recovery requiring confirmation

**Expected**:
- Editor displays merged snapshot (not just attempted)
- Text matches what was saved to canonical
- Images, attachments, reply all reflect merged state

## Implementation Notes

Tests should use real hooks and registry:
- `useDurableComposerDraft`
- `registerDurableComposerDraftAdmissionFlusher`
- `prepareComposerDraftAdmission`

Or use real new-conversation admission path with stubbed final send.

Do NOT use simple `onSend=vi.fn()` without admission flow.

## Existing Test Files to Run

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/chat-input-draft-persistence.test.ts \
  src/components/__tests__/chat-input-draft-boundary-flush.test.ts \
  src/components/new-conversation/__tests__
```

These existing tests should continue to pass and cover some of the admission flow.
