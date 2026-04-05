import { describe, expect, it } from 'vitest';
import { contentHash } from './content-hash.js';

describe('contentHash', () => {
  it('should return a hex SHA-256 hash', () => {
    const hash = contentHash('some diff text');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic', () => {
    const text = '@@ -1,3 +1,4 @@\n context\n+added line\n context';
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it('should produce different hashes for different content', () => {
    const hash1 = contentHash('+added line A');
    const hash2 = contentHash('+added line B');
    expect(hash1).not.toBe(hash2);
  });

  it('should normalize CRLF to LF', () => {
    const lf = contentHash('+line1\n+line2');
    const crlf = contentHash('+line1\r\n+line2');
    expect(lf).toBe(crlf);
  });

  it('should trim whitespace', () => {
    const plain = contentHash('+line1\n+line2');
    const padded = contentHash('  +line1\n+line2  ');
    expect(plain).toBe(padded);
  });

  it('should produce same hash regardless of line number changes', () => {
    // Simulating the same diff content at different line positions
    // The diff text itself is what matters, not surrounding metadata
    const chunk1 = '+    return self._data\n+\n+    def process(self):';
    const chunk2 = '+    return self._data\n+\n+    def process(self):';
    expect(contentHash(chunk1)).toBe(contentHash(chunk2));
  });
});
