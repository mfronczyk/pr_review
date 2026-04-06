/**
 * Lightweight syntax highlighting utility for diff views.
 *
 * Uses highlight.js to tokenize code lines and return pre-rendered HTML.
 * Only a subset of languages is registered to keep the bundle small.
 * The highlighting is intentionally subtle — keywords, strings, comments,
 * and numbers — to avoid visual noise in a diff context.
 */

import hljs from 'highlight.js/lib/core';

// Register commonly-seen languages. Each import adds ~2-8 KB gzipped.
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

/** Map file extensions to highlight.js language names. */
const EXT_TO_LANG: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',

  // Web
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',

  // Data / Config
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'yaml',

  // Systems
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',

  // Scripting
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',

  // Other
  sql: 'sql',
  md: 'markdown',
  mdx: 'markdown',
};

/**
 * Detect the highlight.js language for a file path based on its extension.
 * Returns null if the extension isn't recognized.
 */
function detectLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Highlight an array of code lines for a given file path.
 *
 * Returns an array of HTML strings (one per input line) with `<span class="hljs-*">`
 * wrappers for syntax tokens. If the language is not recognized, the original
 * lines are returned HTML-escaped (safe for dangerouslySetInnerHTML).
 *
 * Lines should have their diff prefix (+/-/space) stripped before being passed here.
 */
export function highlightLines(filePath: string, lines: string[]): string[] {
  const lang = detectLanguage(filePath);
  if (!lang) {
    // No language detected — return HTML-escaped lines
    return lines.map(escapeHtml);
  }

  // Join lines and highlight as a single block to preserve multi-line token state
  // (e.g. template literals, multi-line comments, block strings).
  const joined = lines.join('\n');
  let highlighted: string;
  try {
    highlighted = hljs.highlight(joined, { language: lang }).value;
  } catch {
    return lines.map(escapeHtml);
  }

  // Split back into individual lines. highlight.js output uses \n as line separators.
  return highlighted.split('\n');
}

/** Escape HTML special characters for safe rendering. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
