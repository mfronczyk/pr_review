import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitServiceOptions {
  repoPath: string;
}

/**
 * Service for local git operations: fetching PR refs, computing diffs.
 */
export class GitService {
  private readonly repoPath: string;

  constructor(options: GitServiceOptions) {
    this.repoPath = options.repoPath;
  }

  /**
   * Execute a git command in the repo directory.
   */
  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.repoPath,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
    });
    return stdout;
  }

  /**
   * Fetch the PR head ref from the remote and return the resolved SHA.
   * Uses GitHub's magic refs: `pull/<number>/head`.
   * Does NOT create a local branch — the SHA is used directly for
   * diff, log, and file-content operations.
   *
   * @param prNumber - The PR number
   * @param remote - The git remote name (default: 'origin')
   * @returns The resolved commit SHA
   */
  async fetchPr(prNumber: number, remote = 'origin'): Promise<string> {
    try {
      await this.git('fetch', remote, `pull/${prNumber}/head`);
    } catch (err) {
      throw this.wrapFetchError(err, remote);
    }
    // FETCH_HEAD now points to the PR's tip commit — resolve to a full SHA
    return this.getHeadSha('FETCH_HEAD');
  }

  /**
   * Ensure a specific commit SHA is available locally.
   * Fetches it from the remote if necessary.
   *
   * @param sha - The commit SHA to ensure is fetched
   * @param remote - The git remote name (default: 'origin')
   */
  async ensureShaFetched(sha: string, remote = 'origin'): Promise<void> {
    // Check if the SHA is already available locally
    if (await this.refExists(sha)) return;
    try {
      await this.git('fetch', remote, sha);
    } catch {
      // Some servers don't allow fetching by SHA; this is a best-effort
      // fallback — caller should have the SHA from a prior fetchPr()
    }
  }

  /**
   * Get the merge base between two refs.
   */
  async getMergeBase(ref1: string, ref2: string): Promise<string> {
    const result = await this.git('merge-base', ref1, ref2);
    return result.trim();
  }

  /**
   * Compute the diff between the PR branch and its base.
   * Uses the three-dot diff (base...head) to show only changes
   * introduced by the PR, not changes in the base branch.
   * Enables rename detection (-M) and ignores whitespace at end of line.
   *
   * @param baseRef - The base branch ref (e.g. 'origin/main')
   * @param headRef - The PR branch ref (e.g. 'pr-7272')
   * @returns Raw unified diff string
   */
  async diff(baseRef: string, headRef: string): Promise<string> {
    return this.git('diff', '-M', '--ignore-space-at-eol', `${baseRef}...${headRef}`);
  }

  /**
   * Get the current HEAD sha.
   */
  async getHeadSha(ref: string): Promise<string> {
    const result = await this.git('rev-parse', ref);
    return result.trim();
  }

  /**
   * Fetch latest from remote.
   */
  async fetch(remote = 'origin'): Promise<void> {
    try {
      await this.git('fetch', remote);
    } catch (err) {
      throw this.wrapFetchError(err, remote);
    }
  }

  /**
   * Check if a ref exists locally.
   */
  async refExists(ref: string): Promise<boolean> {
    try {
      await this.git('rev-parse', '--verify', ref);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the commit log between two refs.
   * Returns an array of "short-hash subject" strings, oldest first.
   *
   * Uses the two-dot range (baseRef..headRef) which shows commits reachable
   * from headRef but not from baseRef — i.e., only the PR's own commits.
   * (The three-dot range would include commits on the base branch side of
   * a symmetric difference, inflating the count.)
   *
   * @param baseRef - The base ref (e.g. 'origin/main')
   * @param headRef - The head ref (e.g. 'pr-123')
   * @returns Array of commit subject lines with short hashes
   */
  async getCommitLog(baseRef: string, headRef: string): Promise<string[]> {
    const output = await this.git('log', '--format=%h %s', '--reverse', `${baseRef}..${headRef}`);
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  }

  /**
   * Get the default branch name from the remote.
   */
  async getDefaultBranch(remote = 'origin'): Promise<string> {
    try {
      const result = await this.git('symbolic-ref', `refs/remotes/${remote}/HEAD`);
      // Returns something like "refs/remotes/origin/main"
      const parts = result.trim().split('/');
      return parts[parts.length - 1];
    } catch {
      // Fallback: try common defaults
      for (const branch of ['main', 'master']) {
        if (await this.refExists(`${remote}/${branch}`)) {
          return branch;
        }
      }
      throw new Error('Could not determine default branch');
    }
  }

  /**
   * Get the contents of a file at a specific revision.
   * Uses `git show <ref>:<path>` to retrieve the file content.
   *
   * @param ref - The git ref (e.g. 'pr-123', a commit SHA)
   * @param filePath - The file path relative to the repo root
   * @returns The file content as a string
   */
  async getFileContent(ref: string, filePath: string): Promise<string> {
    return this.git('show', `${ref}:${filePath}`);
  }

  /**
   * Wrap a git fetch error with a helpful message that tells the user
   * what to check and how to fix it.
   */
  private wrapFetchError(err: unknown, remote: string): Error {
    const originalMessage = err instanceof Error ? err.message : String(err);
    const message = [
      `Git fetch failed for remote '${remote}'.`,
      '',
      'Make sure REPO_PATH points to a cloned git repository with an',
      `'${remote}' remote configured.`,
      '',
      `  Repo path: ${this.repoPath}`,
      '',
      'To fix this, either:',
      '  1. Clone the repository into that path:',
      `     git clone <repo-url> ${this.repoPath}`,
      '  2. Set REPO_PATH to an existing clone:',
      '     REPO_PATH=/path/to/clone npm run dev',
      '',
      `Original error: ${originalMessage}`,
    ].join('\n');
    return new Error(message);
  }
}
