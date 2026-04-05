import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve a GitHub auth token using the gh CLI.
 * Works for both github.com and GitHub Enterprise hosts.
 *
 * @param hostname - The GitHub hostname (e.g. 'github.com' or 'github.mycompany.com')
 * @returns The auth token string
 * @throws If gh CLI is not installed or no token is configured for the hostname
 */
export async function resolveGhToken(hostname = 'github.com'): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', hostname]);
    const token = stdout.trim();
    if (!token) {
      throw new Error(`No token returned by gh CLI for hostname: ${hostname}`);
    }
    return token;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to resolve GitHub token for ${hostname}. ` +
        `Ensure gh CLI is installed and authenticated: ${msg}`,
    );
  }
}
