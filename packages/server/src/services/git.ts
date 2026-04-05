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
   * Fetch the PR head ref from the remote.
   * Uses GitHub's magic refs: `pull/<number>/head`
   *
   * @param prNumber - The PR number
   * @param remote - The git remote name (default: 'origin')
   * @returns The local branch name created
   */
  async fetchPr(prNumber: number, remote = 'origin'): Promise<string> {
    const localBranch = `pr-${prNumber}`;
    await this.git('fetch', remote, `pull/${prNumber}/head:${localBranch}`, '--force');
    return localBranch;
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
   *
   * @param baseRef - The base branch ref (e.g. 'origin/main')
   * @param headRef - The PR branch ref (e.g. 'pr-7272')
   * @returns Raw unified diff string
   */
  async diff(baseRef: string, headRef: string): Promise<string> {
    return this.git('diff', `${baseRef}...${headRef}`);
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
    await this.git('fetch', remote);
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
}
