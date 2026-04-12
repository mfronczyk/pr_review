/**
 * Application shell layout with header, theme toggle, and content area.
 */

import { Link, Outlet } from 'react-router-dom';

import { useTheme } from '@/hooks/use-theme';

function ThemeToggle(): React.ReactElement {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-md p-1.5 text-fg-tertiary hover:bg-surface-secondary hover:text-fg-primary"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        // Sun icon
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          role="img"
          aria-label="Switch to light mode"
        >
          <title>Switch to light mode</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ) : (
        // Moon icon
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          role="img"
          aria-label="Switch to dark mode"
        >
          <title>Switch to dark mode</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      )}
    </button>
  );
}

export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-page text-fg-primary">
      <header className="border-b border-border-primary bg-surface-primary">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link to="/" className="text-lg font-semibold text-fg-primary hover:text-blue-500">
            PR Review
          </Link>
          <nav className="flex items-center gap-3 text-sm text-fg-tertiary">
            <Link to="/" className="hover:text-fg-primary">
              Dashboard
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
