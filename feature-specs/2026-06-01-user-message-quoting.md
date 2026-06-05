# User Message Quoting Implementation Plan

**Feature:** #699 — User message quoting — reply with messageId reference
**Goal:** Let users quote historical messages when replying, so agents can locate original context via messageId instead of relying on copy-paste.
**Acceptance Criteria:**
- AC-1: MessageActions toolbar has a "Reply" button for all message types
- AC-2: Clicking Reply shows a quote preview bar above ChatInput (ReplyPill style), dismissible with ×
- AC-3: Sending a message with quote includes `replyTo` in POST /api/messages payload
- AC-4: Backend stores `replyTo` on user messages; history hydrates `replyPreview`
- AC-5: User messages with `replyTo` render ReplyPill in chat (already wired — just needs data)
- AC-6: MCP tool `cat_cafe_get_message` looks up a message by ID + optional surrounding context
- AC-7: Both JSON and multipart (image) sends support `replyTo`
**Architecture cell:** `bubble-pipeline` (touches message rendering path)
**Map delta:** none
**Map delta why:** Extends existing message flow (replyTo already supported by store/types), no new ownership boundaries.
**Architecture:** Reply state in chatStore (setReplyTo/clearReplyTo). MessageActions sets it, ChatInput reads + clears on send. Backend extends sendMessageSchema with `replyTo`, passes through to messageStore.append(). New MCP callback tool for message lookup.
**Tech Stack:** React/Zustand (frontend), Fastify/Zod (backend), MCP SDK (tool)

---

## Straight-Line Check

**Finish line:** User can click Reply on any message → see quote preview above input → send → message stored with replyTo → rendered with ReplyPill → agent can look up the original message by ID.

**Terminal schema:**
```typescript
// sendMessageSchema (Zod)
replyTo: z.string().optional()

// chatStore
replyToMessage: { id: string; content: string; senderCatId: string | null } | null
setReplyTo: (msg: ReplyToTarget) => void
clearReplyTo: () => void

// MCP tool input
{ messageId: string, contextCount?: number }
```

**Not building:** Message threading/nesting, multi-quote, forwarding, inline reply in chat bubbles.

---

## Task 1: Backend — sendMessageSchema + route replyTo passthrough

**Files:**
- Modify: `packages/api/src/routes/messages.schema.ts:14-33`
- Modify: `packages/api/src/routes/parse-multipart.ts:12-93`
- Modify: `packages/api/src/routes/messages.ts:278-840` (all messageStore.append calls)
- Test: `packages/api/test/messages-reply-to.test.js` (new)

### Step 1: Write failing test

```javascript
// test: POST /api/messages with replyTo stores it and returns userMessageId
test('POST /api/messages with replyTo stores replyTo on user message', async () => {
  // Setup: create a parent message, then send a reply referencing it
  const parent = await messageStore.append({ userId: 'user', catId: null, content: 'original', mentions: [], timestamp: Date.now(), threadId: 'test-thread' });
  const res = await app.inject({ method: 'POST', url: '/api/messages', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'reply', threadId: 'test-thread', replyTo: parent.id }) });
  assert.strictEqual(res.statusCode, 200);
  const stored = messageStore.getById(JSON.parse(res.body).userMessageId);
  assert.strictEqual(stored.replyTo, parent.id);
});
```

### Step 2: Add replyTo to sendMessageSchema

```typescript
// messages.schema.ts — add replyTo field
replyTo: z.string().min(1).max(100).optional(),
```

### Step 3: Add replyTo to ParsedMultipart + passthrough

```typescript
// parse-multipart.ts — add replyTo to type and return
replyTo?: string;
// ... in return:
...(parseResult.data.replyTo ? { replyTo: parseResult.data.replyTo } : {}),
```

### Step 4: Extract replyTo in messages.ts route + pass to all append calls

- JSON path: extract `replyTo` from `parseResult.data`
- Multipart path: extract `replyTo` from `parsed`
- Pass `...(replyTo ? { replyTo } : {})` to every `messageStore.append()` call for user messages (lines ~587, ~705, ~806)

### Step 5: Run test, verify pass, commit

---

## Task 2: MCP tool — cat_cafe_get_message

**Files:**
- Modify: `packages/mcp-server/src/tools/callback-tools.ts`
- Modify: `packages/api/src/routes/callbacks.ts`
- Test: `packages/api/test/callback-get-message.test.js` (new)

### Step 1: Write failing test for API route

```javascript
test('GET /api/callbacks/get-message returns message by ID', async () => {
  const msg = await messageStore.append({ userId: 'user', catId: null, content: 'hello world', mentions: [], timestamp: Date.now(), threadId: 'test-thread' });
  const res = await app.inject({ method: 'GET', url: `/api/callbacks/get-message?messageId=${msg.id}`, headers: callbackHeaders });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.message.id, msg.id);
  assert.strictEqual(body.message.content, 'hello world');
});
```

### Step 2: Add API route in callbacks.ts

```typescript
app.get('/api/callbacks/get-message', async (request, reply) => {
  const principal = requireCallbackPrincipal(request, reply);
  if (!principal) return;
  const { messageId, contextCount } = z.object({
    messageId: z.string().min(1),
    contextCount: z.coerce.number().int().min(0).max(10).optional(),
  }).parse(request.query);

  const message = await messageStore.getById(messageId);
  if (!message) { reply.status(404); return { error: 'Message not found' }; }

  let contextMessages = [];
  if (contextCount && contextCount > 0) {
    const threadMessages = await messageStore.getByThread(message.threadId, { limit: contextCount * 2 + 1, around: messageId });
    contextMessages = threadMessages.filter(m => m.id !== messageId);
  }

  return { message: projectMessage(message), context: contextMessages.map(projectMessage) };
});
```

### Step 3: Add MCP tool handler in callback-tools.ts

```typescript
export async function handleGetMessage(input: { messageId: string; contextCount?: number }): Promise<ToolResult> {
  return callbackGet('/api/callbacks/get-message', {
    messageId: input.messageId,
    ...(input.contextCount ? { contextCount: String(input.contextCount) } : {}),
  });
}
```

### Step 4: Register tool in callbackTools array

```typescript
{
  name: 'cat_cafe_get_message',
  description: 'Look up a single message by messageId. Use when a user message includes replyTo — call this to see the original message and its surrounding context. Returns the message content, sender, timestamp, and optionally N nearby messages for context.',
  inputSchema: { ... },
  handler: handleGetMessage,
},
```

### Step 5: Run tests, commit

---

## Task 3: Frontend — chatStore reply state

**Files:**
- Modify: `packages/web/src/stores/chatStore.ts`
- Test: verify via integration (Task 5)

### Step 1: Add reply state to ChatState interface + implementation

```typescript
// Interface addition
replyToMessage: { id: string; content: string; senderCatId: string | null } | null;
setReplyTo: (msg: { id: string; content: string; senderCatId: string | null }) => void;
clearReplyTo: () => void;

// Implementation
replyToMessage: null,
setReplyTo: (msg) => set({ replyToMessage: msg }),
clearReplyTo: () => set({ replyToMessage: null }),
```

### Step 2: Clear reply on thread switch

In the existing `setCurrentThread` or `switchThread` action, add `replyToMessage: null`.

### Step 3: Commit

---

## Task 4: Frontend — MessageActions reply button

**Files:**
- Modify: `packages/web/src/components/MessageActions.tsx:164-221`

### Step 1: Add Reply button to toolbar

Insert between delete and branch buttons:

```tsx
<button
  onClick={() => {
    useChatStore.getState().setReplyTo({
      id: message.id,
      content: message.content,
      senderCatId: message.catId ?? null,
    });
  }}
  className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-cafe-primary transition-colors"
  title="引用回复"
>
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v6M3 10l6-6M3 10l6 6" />
  </svg>
</button>
```

### Step 2: Commit

---

## Task 5: Frontend — ChatInput reply preview + send wiring

**Files:**
- Modify: `packages/web/src/components/ChatInput.tsx:33-172`
- Modify: `packages/web/src/hooks/useSendMessage.ts:56-244`
- Modify: `packages/web/src/components/ChatContainer.tsx:1036-1047`
- Modify: `packages/web/src/components/SplitPaneView.tsx` (onSend signature)

### Step 1: Update ChatInput onSend signature to include replyToId

```typescript
// ChatInputProps.onSend
onSend: (content: string, images?: File[], whisper?: WhisperOptions, deliveryMode?: DeliveryMode, replyToId?: string) => void;
```

### Step 2: Read replyToMessage from store in ChatInput, include in doSend

```typescript
const replyToMessage = useChatStore((s) => s.replyToMessage);
const clearReplyTo = useChatStore((s) => s.clearReplyTo);

// In doSend:
onSend(trimmed, images.length > 0 ? images : undefined, whisper, deliveryMode, replyToMessage?.id);
clearReplyTo();
```

### Step 3: Render reply preview bar above textarea

```tsx
{replyToMessage && (
  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-cafe text-sm text-cafe-secondary bg-cafe-surface-elevated">
    <span className="text-cafe-muted">↩</span>
    <span className="truncate flex-1">{replyToMessage.content.slice(0, 80)}</span>
    <button onClick={clearReplyTo} className="text-cafe-muted hover:text-cafe-primary shrink-0" title="取消引用">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
)}
```

### Step 4: Update useSendMessage.handleSend to accept + pass replyToId

```typescript
// Add replyToId to handleSend params
async (content, images, overrideThreadId, whisper, deliveryMode, replyToId) => {
  // In optimistic userMsg:
  ...(replyToId ? { replyTo: replyToId } : {}),
  // In JSON POST body:
  ...(replyToId ? { replyTo: replyToId } : {}),
  // In FormData:
  if (replyToId) formData.append('replyTo', replyToId);
}
```

### Step 5: Update ChatContainer + SplitPaneView onSend wiring

```tsx
// ChatContainer
onSend={(content, images, whisper, deliveryMode, replyToId) =>
  handleSend(content, images, undefined, whisper, deliveryMode, replyToId)
}

// SplitPaneView — same pattern
```

### Step 6: Commit

---

## Task 6: Lint + type check + test

### Step 1: pnpm check (Biome)
### Step 2: pnpm lint (TypeScript)
### Step 3: pnpm test — verify ≤ 66 failures (baseline)
### Step 4: Fix any issues, commit

---

## Open Questions

None — all technical, resolved during implementation:
- **Reply preview hydration**: Frontend constructs optimistic replyPreview from chatStore message data; server hydrates on history fetch (existing code at messages.ts:1499-1510).
- **MCP contextCount**: Implementation detail — if messageStore lacks an `around` query, fetch by thread + filter. Simple fallback.
