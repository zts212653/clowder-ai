import { describe, expect, it } from 'vitest';
import { cliQuoteSelection, messageQuoteSelection, selectedItems, wholeSelection } from '../message-selection';
import { fixtureData } from './chat-fixture';

describe('message parts retain server block identities', () => {
  it('keeps CLI offsets relative to the selected owner leaf and opens the common text selection state', () => {
    const body = document.createElement('div');
    body.textContent = 'before owner result after';
    document.body.append(body);
    const range = document.createRange();
    range.setStart(body.firstChild!, 7);
    range.setEnd(body.firstChild!, 19);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const source = {
      kind: 'cli_output' as const,
      threadId: 'pdl-test',
      messageId: 'reply-1',
      toolUseId: 'call-1',
      executionRef: 'run-1',
      part: 'result' as const,
    };
    expect(cliQuoteSelection(fixtureData().messages[1], body, selection, source)).toEqual({
      kind: 'textsel',
      mid: 'reply-1',
      text: 'owner result',
      source,
      selectionStart: 7,
      selectionEnd: 19,
    });
    body.remove();
    selection.removeAllRanges();
  });
  it('preserves the selected substring and its offsets in the displayed source leaf', () => {
    const row = document.createElement('div');
    row.dataset.mid = 'reply-1';
    const body = document.createElement('div');
    body.textContent = 'before selected text after';
    row.append(body);
    document.body.append(row);
    const range = document.createRange();
    range.setStart(body.firstChild!, 7);
    range.setEnd(body.firstChild!, 20);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(messageQuoteSelection(fixtureData().messages[1], body, selection)).toEqual({
      kind: 'quote',
      messageId: 'reply-1',
      text: 'selected text',
      selectionStart: 7,
      selectionEnd: 20,
      renderedOccurrences: 1,
    });
    row.remove();
    selection.removeAllRanges();
  });
  it('exports only the selected block after the source list reorders', () => {
    const data = fixtureData(),
      source = data.messages[1];
    const a = { v: 1 as const, kind: 'file' as const, id: 'opaque.block:b', fileName: 'b.txt', url: '/b' };
    const b = { ...a, id: 'a', fileName: 'a.txt' };
    source.extra = { rich: { v: 1, blocks: [a, b] } };
    const picked = { [source.id]: { text: false, blocks: { [a.id]: true } } };
    source.extra.rich!.blocks.reverse();
    expect(selectedItems(data.messages, picked)).toEqual([
      { kind: 'rich_block', messageId: 'reply-1', sourceMessageIds: ['reply-1'], blockId: a.id },
    ]);
    expect(selectedItems(data.messages, { [source.id]: wholeSelection(source) })).toEqual([
      { kind: 'message', messageId: 'reply-1' },
    ]);
  });
  it('rejects recalled or removed selected blocks rather than exporting the whole message', () => {
    const data = fixtureData();
    expect(() => selectedItems(data.messages, { 'reply-1': { text: false, blocks: { removed: true } } })).toThrow(
      '请选择',
    );
    data.messages[1].extra = { recall: { version: 1, exposure: 'seen', recalledAt: 2 } };
    expect(() => selectedItems(data.messages, { 'reply-1': { text: true, blocks: {} } })).toThrow('请选择');
  });
});
