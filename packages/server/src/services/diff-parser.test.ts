import { describe, expect, it } from 'vitest';
import { flattenChunks, parseDiff } from './diff-parser.js';

// ── Fixtures ──────────────────────────────────────────────────

const SIMPLE_DIFF = `diff --git a/src/requests/utils.py b/src/requests/utils.py
index abc1234..def5678 100644
--- a/src/requests/utils.py
+++ b/src/requests/utils.py
@@ -10,6 +10,7 @@ import os
 import sys
 import tempfile
 import warnings
+from typing import Optional
 
 from . import certs
 from ._internal_utils import to_native_string
@@ -45,7 +46,7 @@ def get_encoding_from_headers(headers):
     if not content_type:
         return None
 
-    content_type, params = cgi.parse_header(content_type)
+    content_type, params = parse_header(content_type)
 
     if "charset" in params:
         return params["charset"].strip("'\"")
`;

const MULTI_FILE_DIFF = `diff --git a/src/requests/__init__.py b/src/requests/__init__.py
index 111..222 100644
--- a/src/requests/__init__.py
+++ b/src/requests/__init__.py
@@ -38,6 +38,8 @@
 :license: Apache 2.0, see LICENSE for more details.
 """
 
+from __future__ import annotations
+
 import warnings
diff --git a/src/requests/_types.py b/src/requests/_types.py
new file mode 100644
--- /dev/null
+++ b/src/requests/_types.py
@@ -0,0 +1,10 @@
+"""
+requests._types
+~~~~~~~~~~~~~~~
+
+Type aliases for internal use.
+"""
+
+from __future__ import annotations
+
+from typing import TypeAlias
`;

const DELETED_FILE_DIFF = `diff --git a/old_module.py b/old_module.py
deleted file mode 100644
index abc123..0000000
--- a/old_module.py
+++ /dev/null
@@ -1,5 +0,0 @@
-"""Old module to be removed."""
-
-def old_function():
-    pass
-
`;

const RENAMED_FILE_DIFF = `diff --git a/old_name.py b/new_name.py
similarity index 95%
rename from old_name.py
rename to new_name.py
index abc..def 100644
--- a/old_name.py
+++ b/new_name.py
@@ -1,3 +1,3 @@
-# Old name
+# New name
 
 def func():
`;

const MULTI_HUNK_DIFF = `diff --git a/models.py b/models.py
index abc..def 100644
--- a/models.py
+++ b/models.py
@@ -10,6 +10,7 @@ class Request:
     def __init__(self):
         self.method = None
         self.url = None
+        self.headers = {}
 
     def prepare(self):
         pass
@@ -50,8 +51,9 @@ class Response:
     def __init__(self):
         self.status_code = None
         self.headers = {}
+        self.encoding = None
 
-    def json(self):
+    def json(self, **kwargs):
         return self._json
@@ -100,4 +102,5 @@ class Session:
     def close(self):
         pass
 
+    def __enter__(self):
+        return self
`;

// ── Tests ─────────────────────────────────────────────────────

describe('parseDiff', () => {
  describe('simple single-file diff', () => {
    it('should parse file path correctly', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/requests/utils.py');
    });

    it('should detect modified status', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].status).toBe('modified');
    });

    it('should parse two hunks as two chunks', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks).toHaveLength(2);
    });

    it('should set correct chunk indices', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks[0].chunkIndex).toBe(0);
      expect(result[0].chunks[1].chunkIndex).toBe(1);
    });

    it('should extract correct line ranges from hunk headers', () => {
      const result = parseDiff(SIMPLE_DIFF);

      // First hunk: @@ -10,6 +10,7 @@
      expect(result[0].chunks[0].startLine).toBe(10);
      expect(result[0].chunks[0].endLine).toBe(16);
      expect(result[0].chunks[0].oldStartLine).toBe(10);
      expect(result[0].chunks[0].oldEndLine).toBe(15);

      // Second hunk: @@ -45,7 +46,7 @@
      expect(result[0].chunks[1].startLine).toBe(46);
      expect(result[0].chunks[1].endLine).toBe(52);
      expect(result[0].chunks[1].oldStartLine).toBe(45);
      expect(result[0].chunks[1].oldEndLine).toBe(51);
    });

    it('should include hunk header in diff text', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks[0].diffText).toMatch(/^@@ -10,6 \+10,7 @@/);
    });

    it('should include diff content lines', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks[0].diffText).toContain('+from typing import Optional');
    });

    it('should compute content hashes', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result[0].chunks[1].contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different chunks', () => {
      const result = parseDiff(SIMPLE_DIFF);
      expect(result[0].chunks[0].contentHash).not.toBe(result[0].chunks[1].contentHash);
    });
  });

  describe('multi-file diff', () => {
    it('should parse multiple files', () => {
      const result = parseDiff(MULTI_FILE_DIFF);
      expect(result).toHaveLength(2);
      expect(result[0].filePath).toBe('src/requests/__init__.py');
      expect(result[1].filePath).toBe('src/requests/_types.py');
    });

    it('should detect new file status', () => {
      const result = parseDiff(MULTI_FILE_DIFF);
      expect(result[1].status).toBe('added');
    });

    it('should set oldPath to null for non-renamed files', () => {
      const result = parseDiff(MULTI_FILE_DIFF);
      expect(result[0].oldPath).toBeNull();
    });
  });

  describe('deleted file', () => {
    it('should detect deleted status', () => {
      const result = parseDiff(DELETED_FILE_DIFF);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('deleted');
    });

    it('should parse the removal hunk', () => {
      const result = parseDiff(DELETED_FILE_DIFF);
      expect(result[0].chunks).toHaveLength(1);
      expect(result[0].chunks[0].diffText).toContain('-"""Old module to be removed."""');
    });
  });

  describe('renamed file', () => {
    it('should detect renamed status', () => {
      const result = parseDiff(RENAMED_FILE_DIFF);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('renamed');
    });

    it('should set oldPath for renamed files', () => {
      const result = parseDiff(RENAMED_FILE_DIFF);
      expect(result[0].filePath).toBe('new_name.py');
      expect(result[0].oldPath).toBe('old_name.py');
    });
  });

  describe('multi-hunk file', () => {
    it('should parse three hunks as three chunks', () => {
      const result = parseDiff(MULTI_HUNK_DIFF);
      expect(result).toHaveLength(1);
      expect(result[0].chunks).toHaveLength(3);
    });

    it('should have correct line ranges for each hunk', () => {
      const result = parseDiff(MULTI_HUNK_DIFF);
      const chunks = result[0].chunks;

      // @@ -10,6 +10,7 @@
      expect(chunks[0].startLine).toBe(10);
      expect(chunks[0].endLine).toBe(16);

      // @@ -50,8 +51,9 @@
      expect(chunks[1].startLine).toBe(51);
      expect(chunks[1].endLine).toBe(59);

      // @@ -100,4 +102,5 @@
      expect(chunks[2].startLine).toBe(102);
      expect(chunks[2].endLine).toBe(106);
    });
  });

  describe('content hash stability', () => {
    it('should produce same hash when parsing same diff twice', () => {
      const result1 = parseDiff(SIMPLE_DIFF);
      const result2 = parseDiff(SIMPLE_DIFF);
      expect(result1[0].chunks[0].contentHash).toBe(result2[0].chunks[0].contentHash);
    });

    it('should produce different hashes for different content at same line', () => {
      const diff1 = `diff --git a/f.py b/f.py
index abc..def 100644
--- a/f.py
+++ b/f.py
@@ -1,3 +1,3 @@
-old line
+new line A
 context
`;

      const diff2 = `diff --git a/f.py b/f.py
index abc..def 100644
--- a/f.py
+++ b/f.py
@@ -1,3 +1,3 @@
-old line
+new line B
 context
`;

      const chunks1 = parseDiff(diff1);
      const chunks2 = parseDiff(diff2);
      expect(chunks1[0].chunks[0].contentHash).not.toBe(chunks2[0].chunks[0].contentHash);
    });

    it('should produce same hash when line numbers shift but content is identical', () => {
      // Simulates a chunk that moved from line 10 to line 25 due to additions above
      const diffBefore = `diff --git a/src/utils.py b/src/utils.py
index abc..def 100644
--- a/src/utils.py
+++ b/src/utils.py
@@ -10,6 +10,7 @@ import os
 import sys
 import tempfile
+from typing import Optional
 
 from . import certs
`;

      const diffAfter = `diff --git a/src/utils.py b/src/utils.py
index abc..def 100644
--- a/src/utils.py
+++ b/src/utils.py
@@ -25,6 +30,7 @@ import os
 import sys
 import tempfile
+from typing import Optional
 
 from . import certs
`;

      const chunksBefore = parseDiff(diffBefore);
      const chunksAfter = parseDiff(diffAfter);
      expect(chunksBefore[0].chunks[0].contentHash).toBe(chunksAfter[0].chunks[0].contentHash);
    });

    it('should produce different hashes for identical content in different files', () => {
      const diff = `diff --git a/src/a.py b/src/a.py
index abc..def 100644
--- a/src/a.py
+++ b/src/a.py
@@ -1,3 +1,4 @@
 context
+import os
 more context
diff --git a/src/b.py b/src/b.py
index abc..def 100644
--- a/src/b.py
+++ b/src/b.py
@@ -1,3 +1,4 @@
 context
+import os
 more context
`;

      const result = parseDiff(diff);
      expect(result).toHaveLength(2);
      expect(result[0].chunks[0].contentHash).not.toBe(result[1].chunks[0].contentHash);
    });

    it('should differentiate hunks with same content but different function context', () => {
      const diff = `diff --git a/models.py b/models.py
index abc..def 100644
--- a/models.py
+++ b/models.py
@@ -10,3 +10,4 @@ class Foo:
 context
+    self.x = 1
 more
@@ -50,3 +51,4 @@ class Bar:
 context
+    self.x = 1
 more
`;

      const result = parseDiff(diff);
      expect(result[0].chunks).toHaveLength(2);
      // Same content lines but different function context → different hashes
      expect(result[0].chunks[0].contentHash).not.toBe(result[0].chunks[1].contentHash);
    });
  });

  describe('edge cases', () => {
    it('should handle empty diff', () => {
      const result = parseDiff('');
      expect(result).toHaveLength(0);
    });

    it('should handle diff with no hunks (binary file)', () => {
      const diff = `diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ
`;
      const result = parseDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].chunks).toHaveLength(0);
    });
  });
});

describe('flattenChunks', () => {
  it('should flatten chunks from multiple files', () => {
    const result = parseDiff(MULTI_FILE_DIFF);
    const flat = flattenChunks(result);

    // __init__.py has 1 hunk, _types.py has 1 hunk
    expect(flat).toHaveLength(2);
    expect(flat[0].filePath).toBe('src/requests/__init__.py');
    expect(flat[1].filePath).toBe('src/requests/_types.py');
  });

  it('should preserve chunk indices per file', () => {
    const result = parseDiff(MULTI_HUNK_DIFF);
    const flat = flattenChunks(result);

    expect(flat).toHaveLength(3);
    expect(flat[0].chunkIndex).toBe(0);
    expect(flat[1].chunkIndex).toBe(1);
    expect(flat[2].chunkIndex).toBe(2);
  });

  it('should propagate fileStatus from the parent file diff', () => {
    const result = parseDiff(MULTI_FILE_DIFF);
    const flat = flattenChunks(result);

    expect(flat[0].fileStatus).toBe('modified');
    expect(flat[1].fileStatus).toBe('added');
  });

  it('should set fileStatus to deleted for removed file chunks', () => {
    const result = parseDiff(DELETED_FILE_DIFF);
    const flat = flattenChunks(result);

    expect(flat).toHaveLength(1);
    expect(flat[0].fileStatus).toBe('deleted');
  });

  it('should set fileStatus to renamed for renamed file chunks', () => {
    const result = parseDiff(RENAMED_FILE_DIFF);
    const flat = flattenChunks(result);

    expect(flat).toHaveLength(1);
    expect(flat[0].fileStatus).toBe('renamed');
  });

  it('should set same fileStatus on all chunks of a multi-hunk file', () => {
    const result = parseDiff(MULTI_HUNK_DIFF);
    const flat = flattenChunks(result);

    expect(flat).toHaveLength(3);
    for (const chunk of flat) {
      expect(chunk.fileStatus).toBe('modified');
    }
  });
});
