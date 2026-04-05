/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          page: 'rgb(var(--color-surface-page) / <alpha-value>)',
          primary: 'rgb(var(--color-surface-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-surface-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--color-surface-tertiary) / <alpha-value>)',
          active: 'rgb(var(--color-surface-active) / <alpha-value>)',
          input: 'rgb(var(--color-surface-input) / <alpha-value>)',
        },
        fg: {
          primary: 'rgb(var(--color-fg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--color-fg-tertiary) / <alpha-value>)',
          muted: 'rgb(var(--color-fg-muted) / <alpha-value>)',
          faint: 'rgb(var(--color-fg-faint) / <alpha-value>)',
        },
        border: {
          primary: 'rgb(var(--color-border-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-border-secondary) / <alpha-value>)',
        },
        'diff-add': {
          bg: 'rgb(var(--color-diff-add-bg) / <alpha-value>)',
          fg: 'rgb(var(--color-diff-add-fg) / <alpha-value>)',
        },
        'diff-del': {
          bg: 'rgb(var(--color-diff-del-bg) / <alpha-value>)',
          fg: 'rgb(var(--color-diff-del-fg) / <alpha-value>)',
        },
        'diff-info': {
          bg: 'rgb(var(--color-diff-info-bg) / <alpha-value>)',
          fg: 'rgb(var(--color-diff-info-fg) / <alpha-value>)',
        },
        'diff-note': {
          bg: 'rgb(var(--color-diff-note-bg) / <alpha-value>)',
          fg: 'rgb(var(--color-diff-note-fg) / <alpha-value>)',
        },
        'error-bg': 'rgb(var(--color-error-bg) / <alpha-value>)',
        'error-fg': 'rgb(var(--color-error-fg) / <alpha-value>)',
        'error-border': 'rgb(var(--color-error-border) / <alpha-value>)',
        'success-fg': 'rgb(var(--color-success-fg) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
