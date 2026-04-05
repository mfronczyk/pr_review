import { Octokit } from '@octokit/rest';
import { resolveGhToken } from './gh-token.js';

/** Cache of Octokit instances keyed by hostname */
const clientCache = new Map<string, Octokit>();

/**
 * Get an authenticated Octokit instance for the given GitHub host.
 * Instances are cached per hostname for the lifetime of the process.
 *
 * @param hostname - The GitHub hostname (default: 'github.com')
 * @returns Authenticated Octokit instance
 */
export async function getOctokit(hostname = 'github.com'): Promise<Octokit> {
  const cached = clientCache.get(hostname);
  if (cached) {
    return cached;
  }

  const token = await resolveGhToken(hostname);
  const baseUrl =
    hostname === 'github.com' ? 'https://api.github.com' : `https://${hostname}/api/v3`;

  const octokit = new Octokit({
    auth: token,
    baseUrl,
  });

  clientCache.set(hostname, octokit);
  return octokit;
}

/**
 * Clear the Octokit client cache. Useful for testing or when tokens expire.
 */
export function clearOctokitCache(): void {
  clientCache.clear();
}
