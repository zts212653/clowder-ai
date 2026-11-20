import { describe, expect, it } from 'vitest';
import { readThreadExportAddress } from '../export-route';

describe('engine export address parameters', () => {
  it('binds the hash owner and distinguishes all messages from an exact selection', () => {
    expect(readThreadExportAddress({ hash: '#export-thread%2Fopaque', search: '' })).toEqual({
      threadId: 'thread/opaque',
      mids: null,
    });
    expect(readThreadExportAddress({ hash: '#export-thread-1', search: '?messageId=one&messageId=two' })).toEqual({
      threadId: 'thread-1',
      mids: ['one', 'two'],
    });
    expect(readThreadExportAddress({ hash: '#chat-thread-1', search: '' })).toBeNull();
  });
  it('rejects duplicate or empty selection identities instead of silently exporting different content', () => {
    expect(() => readThreadExportAddress({ hash: '#export-a', search: '?messageId=a&messageId=a' })).toThrow();
    expect(() => readThreadExportAddress({ hash: '#export-a', search: '?messageId=' })).toThrow();
  });
});
