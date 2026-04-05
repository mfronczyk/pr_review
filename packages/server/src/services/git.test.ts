import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock promisify to return our mock
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

describe('GitService', () => {
  let git: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    git = new GitService({ repoPath: '/tmp/test-repo' });
  });

  describe('fetchPr', () => {
    it('should fetch PR ref and return local branch name', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as never);

      const branch = await git.fetchPr(7272);

      expect(branch).toBe('pr-7272');
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', 'pull/7272/head:pr-7272', '--force'],
        expect.objectContaining({ cwd: '/tmp/test-repo' }),
      );
    });

    it('should use custom remote', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as never);

      await git.fetchPr(123, 'upstream');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['fetch', 'upstream', 'pull/123/head:pr-123', '--force'],
        expect.objectContaining({ cwd: '/tmp/test-repo' }),
      );
    });
  });

  describe('diff', () => {
    it('should run git diff with three-dot notation', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'diff output here', stderr: '' } as never);

      const result = await git.diff('origin/main', 'pr-7272');

      expect(result).toBe('diff output here');
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['diff', 'origin/main...pr-7272'],
        expect.objectContaining({ cwd: '/tmp/test-repo' }),
      );
    });
  });

  describe('getHeadSha', () => {
    it('should return trimmed SHA', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'abc123def456\n', stderr: '' } as never);

      const sha = await git.getHeadSha('pr-7272');

      expect(sha).toBe('abc123def456');
    });
  });

  describe('refExists', () => {
    it('should return true when ref exists', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'abc123\n', stderr: '' } as never);

      const exists = await git.refExists('pr-7272');

      expect(exists).toBe(true);
    });

    it('should return false when ref does not exist', async () => {
      mockExecFile.mockRejectedValue(new Error('not a valid ref') as never);

      const exists = await git.refExists('nonexistent');

      expect(exists).toBe(false);
    });
  });

  describe('getDefaultBranch', () => {
    it('should parse default branch from symbolic ref', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'refs/remotes/origin/main\n',
        stderr: '',
      } as never);

      const branch = await git.getDefaultBranch();

      expect(branch).toBe('main');
    });

    it('should fallback to checking main/master when symbolic ref fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'));
      // refExists for 'origin/main'
      mockExecFile.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' } as never);

      const branch = await git.getDefaultBranch();

      expect(branch).toBe('main');
    });
  });
});
