import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareAbstractiveBatch } from '../../src/domains/memory/abstractive-summary-input.js';
import { SYSTEM_PROMPT } from '../../src/domains/memory/abstractive-summary-prompt.js';

test('summary projects visible text once and never serializes controls or binary payloads', () => {
  const body = 'UNIQUE-VISIBLE-BODY';
  const prepared = prepareAbstractiveBatch({
    threadId: 'fixture',
    previousSummary: null,
    messages: [
      {
        id: 'message',
        timestamp: 1000,
        content: body,
        contentBlocks: [
          { type: 'text', text: body },
          { type: 'tool_call', toolName: 'hidden-tool', toolId: 'control', input: { token: 'TOOL-SECRET' } },
          { type: 'tool_result', toolId: 'control', result: { token: 'RESULT-SECRET' } },
          { type: 'image', url: 'data:image/png;base64,IMAGE-BINARY', alt: 'Visible image caption' },
          {
            type: 'file',
            url: '/uploads/FILE-CONTROL',
            fileName: 'visible.pdf',
            mimeType: 'application/pdf',
            fileSize: 32,
          },
          { type: 'code', code: 'visibleCode()', filename: 'visible.ts' },
          {
            type: 'context_attachment',
            attachment: {
              v: 1,
              id: 'thread',
              kind: 'thread',
              threadId: 'HIDDEN-THREAD-ID',
              title: 'Visible linked thread',
            },
          },
        ],
        richBlocks: [
          {
            v: 1,
            id: 'card',
            kind: 'card',
            title: 'Visible card',
            bodyMarkdown: 'Visible card body',
            fields: [{ label: 'Visible field', value: 'Visible value' }],
            actions: [{ label: 'Act', action: 'hidden', payload: { callbackToken: 'CALLBACK-SECRET' } }],
            meta: { invocationId: 'META-SECRET' },
          },
          {
            v: 1,
            id: 'interactive',
            kind: 'interactive',
            interactiveType: 'select',
            title: 'Visible choice',
            description: 'Visible choice description',
            options: [
              {
                id: 'private-option-id',
                label: 'Visible option',
                description: 'Visible option description',
                action: { type: 'callback', endpoint: '/PRIVATE-ENDPOINT', payload: { token: 'PAYLOAD-SECRET' } },
              },
            ],
            messageTemplate: 'TEMPLATE-SECRET',
          },
          {
            v: 1,
            id: 'html',
            kind: 'html_widget',
            title: 'Visible widget title',
            html: '<script>HTML-SECRET</script>',
          },
          {
            v: 1,
            id: 'gallery',
            kind: 'media_gallery',
            title: 'Visible gallery',
            items: [{ url: 'data:image/png;base64,GALLERY-BINARY', caption: 'Visible gallery caption' }],
          },
          {
            v: 1,
            id: 'audio',
            kind: 'audio',
            url: 'https://fixture.invalid/AUDIO-CONTROL',
            text: 'Visible transcript',
          },
          {
            v: 1,
            id: 'checklist',
            kind: 'checklist',
            items: [{ id: 'CHECKBOX-CONTROL', text: 'Visible checklist text', checked: true }],
          },
          { v: 1, id: 'diff', kind: 'diff', filePath: 'visible.diff', diff: '+ visible change' },
          { v: 1, id: 'file', kind: 'file', fileName: 'visible.docx', url: '/uploads/RICH-FILE-CONTROL' },
        ],
      },
    ],
  });
  const prompt = prepared?.prompts.join('\n') ?? '';
  for (const hidden of [
    'TOOL-SECRET',
    'RESULT-SECRET',
    'IMAGE-BINARY',
    'FILE-CONTROL',
    'CALLBACK-SECRET',
    'META-SECRET',
    'PRIVATE-ENDPOINT',
    'PAYLOAD-SECRET',
    'TEMPLATE-SECRET',
    'HTML-SECRET',
    'GALLERY-BINARY',
    'AUDIO-CONTROL',
    'CHECKBOX-CONTROL',
    'RICH-FILE-CONTROL',
    'HIDDEN-THREAD-ID',
  ]) {
    assert.ok(!prompt.includes(hidden), `hidden field escaped visible projection: ${hidden}`);
  }
  assert.equal(prompt.split(body).length - 1, 1);
  for (const visible of [
    'Visible image caption',
    'visible.pdf',
    'visibleCode()',
    'Visible linked thread',
    'Visible card',
    'Visible value',
    'Visible option',
    'Visible option description',
    'Visible widget title',
    'Visible gallery caption',
    'Visible transcript',
    'Visible checklist text',
    'visible change',
    'visible.docx',
  ]) {
    assert.ok(prompt.includes(visible), `visible text was lost: ${visible}`);
  }
});

test('GOOD candidates all demonstrate the required source suffix', () => {
  const examples = SYSTEM_PROMPT.split('GOOD (these ARE durable knowledge):')[1].trim().split('\n');
  assert.equal(examples.length, 4);
  for (const example of examples) assert.match(example, /\[sources:\s*[^\]]+\]$/);
});

test('quote source contributes its coordinate without serializing hidden metadata', () => {
  const source = JSON.parse(
    '{"kind":"message","threadId":"source-thread","messageId":"source-message","callbackToken":"QUOTE-SOURCE-SECRET"}',
  );
  const input = prepareAbstractiveBatch({
    threadId: 'fixture',
    previousSummary: null,
    messages: [
      {
        id: 'outer',
        timestamp: 1000,
        content: '',
        contentBlocks: [
          {
            type: 'context_attachment',
            attachment: {
              v: 1,
              id: 'quote',
              kind: 'quote',
              text: 'Visible quoted words',
              comment: 'Visible owner response',
              source,
            },
          },
        ],
        quotedAuthors: { quote: 'opus55' },
      },
    ],
  });
  const prompt = input?.prompts.join('\n') ?? '';
  assert.ok(prompt.includes('source-thread#source-message'));
  assert.ok(prompt.includes('Visible quoted words'));
  assert.ok(prompt.includes('Visible owner response'));
  assert.ok(!prompt.includes('QUOTE-SOURCE-SECRET'));
});
