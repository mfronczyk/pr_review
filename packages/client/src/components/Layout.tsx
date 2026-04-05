/**
 * Application shell layout with header and content area.
 */

import { Link, Outlet } from 'react-router-dom';

export function Layout(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link to="/" className="text-lg font-semibold text-white hover:text-blue-400">
            PR Review
          </Link>
          <nav className="flex items-center gap-4 text-sm text-gray-400">
            <Link to="/" className="hover:text-white">
              Dashboard
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
