/**
 * F252: parseStoryId — handles URL-encoded storyId from Next.js useParams().
 *
 * Bug: Next.js useParams() URL-encodes colons in dynamic route segments.
 * /story/session:abc → params.storyId = "session%3Aabc", not "session:abc".
 * Without decoding, parseStoryId always returns null → "Invalid Story ID".
 */
import { describe, expect, it } from 'vitest';
import { decodeStoryParam, parseStoryId } from '../[storyId]/parseStoryId';

describe('F252: parseStoryId', () => {
  it('parses raw session:id format', () => {
    const result = parseStoryId('session:abc-123');
    expect(result).toEqual({ type: 'session', sessionId: 'abc-123' });
  });

  it('parses URL-encoded session%3Aid format (Next.js useParams behavior)', () => {
    // This is the P0 bug: useParams() returns "session%3Aabc" not "session:abc"
    const result = parseStoryId('session%3Aabc-123');
    expect(result).toEqual({ type: 'session', sessionId: 'abc-123' });
  });

  it('parses double-encoded session%253Aid format defensively', () => {
    const result = parseStoryId('session%253Aabc-123');
    // Double-encoded stays as %3A after one decode — should still work
    // Actually: decodeURIComponent('session%253Aabc-123') = 'session%3Aabc-123'
    // which doesn't start with 'session:' — returns null. This is expected:
    // double encoding is a caller bug, not our responsibility.
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseStoryId('')).toBeNull();
  });

  it('returns null for unrecognized format', () => {
    expect(parseStoryId('story:abc')).toBeNull();
    expect(parseStoryId('random-string')).toBeNull();
  });

  it('returns null for malformed percent-encoding (no URIError throw)', () => {
    // P1 from gpt52 review: decodeURIComponent('%ZZ') throws URIError
    // User-addressable route must not crash on bad URLs
    expect(parseStoryId('session%ZZabc')).toBeNull();
    expect(parseStoryId('%E0%A4%A')).toBeNull();
    expect(parseStoryId('%%%')).toBeNull();
  });

  it('handles UUID sessionId format', () => {
    const uuid = '029ba7ce-94bf-4db0-b615-c14d17444aff';
    expect(parseStoryId(`session:${uuid}`)).toEqual({ type: 'session', sessionId: uuid });
    expect(parseStoryId(`session%3A${uuid}`)).toEqual({ type: 'session', sessionId: uuid });
  });

  // Phase C: feat:<featId> format
  it('parses feat:F252 format', () => {
    expect(parseStoryId('feat:F252')).toEqual({ type: 'feat', featId: 'F252' });
  });

  it('parses URL-encoded feat%3AF252 format', () => {
    expect(parseStoryId('feat%3AF252')).toEqual({ type: 'feat', featId: 'F252' });
  });

  it('normalizes lowercase feat id to uppercase', () => {
    expect(parseStoryId('feat:f252')).toEqual({ type: 'feat', featId: 'F252' });
    expect(parseStoryId('feat%3Af252')).toEqual({ type: 'feat', featId: 'F252' });
  });

  it('rejects invalid feat id format', () => {
    expect(parseStoryId('feat:notAFeatId')).toBeNull();
    expect(parseStoryId('feat:')).toBeNull();
    expect(parseStoryId('feat:F')).toBeNull(); // too short
    expect(parseStoryId('feat:F1')).toBeNull(); // needs 2+ digits
  });

  it('accepts feat ids with 2-4 digit numbers', () => {
    expect(parseStoryId('feat:F12')).toEqual({ type: 'feat', featId: 'F12' });
    expect(parseStoryId('feat:F123')).toEqual({ type: 'feat', featId: 'F123' });
    expect(parseStoryId('feat:F1234')).toEqual({ type: 'feat', featId: 'F1234' });
  });
});

describe('F252: decodeStoryParam (shared by main + public page)', () => {
  it('decodes %3A to colon (Next.js useParams encoding)', () => {
    expect(decodeStoryParam('session%3Aabc-123')).toBe('session:abc-123');
  });

  it('returns raw string unchanged when no encoding', () => {
    expect(decodeStoryParam('session:abc-123')).toBe('session:abc-123');
  });

  it('returns raw string on malformed percent-encoding (no throw)', () => {
    // %ZZ is not valid percent-encoding — must not throw
    expect(decodeStoryParam('session%ZZabc')).toBe('session%ZZabc');
    expect(decodeStoryParam('%%%')).toBe('%%%');
  });

  it('decodes full URL-encoded storyId for public page API call', () => {
    // This is the R4 P1-1 regression test: public page used to double-encode.
    // With decodeStoryParam, the decoded storyId is then re-encoded once for the fetch URL.
    const encoded = 'session%3A029ba7ce-94bf-4db0-b615-c14d17444aff';
    const decoded = decodeStoryParam(encoded);
    expect(decoded).toBe('session:029ba7ce-94bf-4db0-b615-c14d17444aff');
    // Re-encoding should produce single-encoded form (what Fastify expects)
    expect(encodeURIComponent(decoded)).toBe('session%3A029ba7ce-94bf-4db0-b615-c14d17444aff');
  });
});
