import { describe, expect, it } from 'vitest';
import { chunkContentHash } from './content-hash.js';

describe('chunkContentHash', () => {
  it('should return a hex SHA-256 hash', () => {
    const hash = chunkContentHash('src/a.ts', '@@ -1,3 +1,4 @@\n context\n+added\n context');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic', () => {
    const text = '@@ -1,3 +1,4 @@\n context\n+added\n context';
    expect(chunkContentHash('src/a.ts', text)).toBe(chunkContentHash('src/a.ts', text));
  });

  it('should produce same hash when only line numbers in @@ header differ', () => {
    const chunk1 = '@@ -10,6 +10,7 @@\n context\n+added line\n context';
    const chunk2 = '@@ -25,6 +30,7 @@\n context\n+added line\n context';
    expect(chunkContentHash('src/a.ts', chunk1)).toBe(chunkContentHash('src/a.ts', chunk2));
  });

  it('should produce same hash for shifted line numbers with function context', () => {
    const chunk1 = '@@ -10,6 +10,7 @@ class Request:\n context\n+added\n context';
    const chunk2 = '@@ -50,6 +55,7 @@ class Request:\n context\n+added\n context';
    expect(chunkContentHash('src/a.ts', chunk1)).toBe(chunkContentHash('src/a.ts', chunk2));
  });

  it('should produce different hashes for different function context', () => {
    const chunk1 = '@@ -10,6 +10,7 @@ class Request:\n context\n+added\n context';
    const chunk2 = '@@ -10,6 +10,7 @@ class Response:\n context\n+added\n context';
    expect(chunkContentHash('src/a.ts', chunk1)).not.toBe(chunkContentHash('src/a.ts', chunk2));
  });

  it('should produce different hashes for same content in different files', () => {
    const text = '@@ -10,6 +10,7 @@\n context\n+added line\n context';
    expect(chunkContentHash('src/a.ts', text)).not.toBe(chunkContentHash('src/b.ts', text));
  });

  it('should produce different hashes for different diff content', () => {
    const chunk1 = '@@ -1,3 +1,3 @@\n-old line\n+new line A\n context';
    const chunk2 = '@@ -1,3 +1,3 @@\n-old line\n+new line B\n context';
    expect(chunkContentHash('src/a.ts', chunk1)).not.toBe(chunkContentHash('src/a.ts', chunk2));
  });

  it('should normalize CRLF to LF', () => {
    const lf = chunkContentHash('src/a.ts', '@@ -1,2 +1,2 @@\n+line1\n+line2');
    const crlf = chunkContentHash('src/a.ts', '@@ -1,2 +1,2 @@\r\n+line1\r\n+line2');
    expect(lf).toBe(crlf);
  });

  it('should trim whitespace', () => {
    const plain = chunkContentHash('src/a.ts', '@@ -1,2 +1,2 @@\n+line1\n+line2');
    const padded = chunkContentHash('src/a.ts', '  @@ -1,2 +1,2 @@\n+line1\n+line2  ');
    expect(plain).toBe(padded);
  });

  it('should handle hunk header without function context', () => {
    const chunk1 = '@@ -1,3 +1,4 @@\n context\n+added\n context';
    const chunk2 = '@@ -100,3 +200,4 @@\n context\n+added\n context';
    expect(chunkContentHash('src/a.ts', chunk1)).toBe(chunkContentHash('src/a.ts', chunk2));
  });

  it('should handle hunk header with single line count (no comma)', () => {
    const chunk1 = '@@ -1 +1 @@\n+single line';
    const chunk2 = '@@ -50 +60 @@\n+single line';
    expect(chunkContentHash('src/a.ts', chunk1)).toBe(chunkContentHash('src/a.ts', chunk2));
  });
});
