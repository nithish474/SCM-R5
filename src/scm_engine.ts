import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitCommitInfo {
  commit_hash: string;
  short_hash: string;
  author: string;
  author_email: string;
  timestamp: string;
  message: string;
  branch: string;
  parent_hashes: string[];
}

export interface GitChangedFile {
  filepath: string;
  change_type: 'A' | 'M' | 'D' | 'R' | 'C' | 'U';
  lines_added: number;
  lines_deleted: number;
  old_filepath?: string;
  blame_author?: string;
}

export interface GitRepoStatus {
  is_git: boolean;
  branch?: string;
  commit_count?: number;
  head_commit?: string;
  error?: string;
}

/**
 * Safely executes git command with timeout and environment protection.
 */
async function runGit(args: string[], cwd: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C'
      }
    });
  } catch (err: any) {
    throw new Error(`Git command "git ${args.join(' ')}" failed: ${err.stderr || err.message}`);
  }
}

/**
 * Check whether a directory is a valid Git repository and get status.
 */
export async function getGitRepoStatus(repoPath: string): Promise<GitRepoStatus> {
  if (!fs.existsSync(repoPath)) {
    return { is_git: false, error: 'Path does not exist on filesystem' };
  }

  try {
    const { stdout: isInside } = await runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
    if (isInside.trim() !== 'true') {
      return { is_git: false, error: 'Directory is not inside a git work tree' };
    }

    let branch = 'HEAD';
    try {
      const { stdout: branchOut } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      branch = branchOut.trim();
    } catch {
      // Empty repo or detached HEAD
    }

    let commitCount = 0;
    let headCommit = '';
    try {
      const { stdout: countOut } = await runGit(['rev-list', '--count', 'HEAD'], repoPath);
      commitCount = parseInt(countOut.trim(), 10) || 0;
      const { stdout: headOut } = await runGit(['rev-parse', 'HEAD'], repoPath);
      headCommit = headOut.trim();
    } catch {
      // Empty repo with no commits yet
    }

    return {
      is_git: true,
      branch,
      commit_count: commitCount,
      head_commit: headCommit
    };
  } catch (err: any) {
    return { is_git: false, error: err.message };
  }
}

/**
 * Read genuine Git commits from repository.
 */
export async function getRealGitCommits(repoPath: string, limit = 50): Promise<GitCommitInfo[]> {
  const status = await getGitRepoStatus(repoPath);
  if (!status.is_git || !status.head_commit) {
    return [];
  }

  try {
    // Format: Hash%x1fAuthor%x1fEmail%x1fDate%x1fParents%x1fSubject%x1e
    const format = '%H%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1e';
    const { stdout } = await runGit(
      ['log', `-${limit}`, `--date=iso`, `--format=${format}`],
      repoPath
    );

    const records = stdout.split('\x1e').filter((rec) => rec.trim().length > 0);
    const commits: GitCommitInfo[] = [];

    for (const rec of records) {
      const parts = rec.trim().split('\x1f');
      if (parts.length >= 6) {
        const hash = parts[0].trim();
        const author = parts[1].trim();
        const email = parts[2].trim();
        const timestamp = parts[3].trim();
        const parents = parts[4].trim() ? parts[4].trim().split(' ') : [];
        const message = parts[5].trim();

        commits.push({
          commit_hash: hash,
          short_hash: hash.substring(0, 7),
          author,
          author_email: email,
          timestamp,
          message,
          branch: status.branch || 'main',
          parent_hashes: parents
        });
      }
    }

    return commits;
  } catch (err: any) {
    console.warn(`[CodeGuard SCM] Error reading git log:`, err.message);
    return [];
  }
}

/**
 * Get changed files, diffs, line additions and deletions for a specific commit.
 * Handles initial commit (no parent), merge commits, and regular commits.
 */
export async function getRealCommitChanges(repoPath: string, commitHash: string): Promise<{
  commit: GitCommitInfo;
  changed_files: GitChangedFile[];
  total_lines_added: number;
  total_lines_deleted: number;
}> {
  const status = await getGitRepoStatus(repoPath);
  if (!status.is_git) {
    throw new Error(`Path "${repoPath}" is not a valid Git repository.`);
  }

  // Resolve commit hash
  let fullHash = '';
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${commitHash}^{commit}`], repoPath);
    fullHash = stdout.trim();
  } catch {
    throw new Error(`Commit "${commitHash}" does not exist in this repository.`);
  }

  // Read commit details
  const format = '%H%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s';
  const { stdout: commitRaw } = await runGit(['show', '-s', `--date=iso`, `--format=${format}`, fullHash], repoPath);
  const parts = commitRaw.trim().split('\x1f');
  if (parts.length < 6) {
    throw new Error(`Failed to parse commit metadata for ${fullHash}`);
  }

  const commitInfo: GitCommitInfo = {
    commit_hash: fullHash,
    short_hash: fullHash.substring(0, 7),
    author: parts[1].trim(),
    author_email: parts[2].trim(),
    timestamp: parts[3].trim(),
    message: parts[5].trim(),
    branch: status.branch || 'main',
    parent_hashes: parts[4].trim() ? parts[4].trim().split(' ') : []
  };

  // Inspect changes using diff-tree / numstat
  let numstatOutput = '';
  let nameStatusOutput = '';

  if (commitInfo.parent_hashes.length === 0) {
    // Initial commit (root): compare against 4b825dc642cb6eb9a060e54bf8d69288fbee4904 (empty tree SHA)
    const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const { stdout: numstat } = await runGit(['diff-tree', '--numstat', '-r', emptyTreeSha, fullHash], repoPath);
    numstatOutput = numstat;
    const { stdout: nameStatus } = await runGit(['diff-tree', '--name-status', '-r', emptyTreeSha, fullHash], repoPath);
    nameStatusOutput = nameStatus;
  } else {
    // Normal commit: compare with first parent
    const parent = commitInfo.parent_hashes[0];
    const { stdout: numstat } = await runGit(['diff-tree', '--numstat', '-r', parent, fullHash], repoPath);
    numstatOutput = numstat;
    const { stdout: nameStatus } = await runGit(['diff-tree', '--name-status', '-r', parent, fullHash], repoPath);
    nameStatusOutput = nameStatus;
  }

  const statusMap = new Map<string, { type: GitChangedFile['change_type']; oldPath?: string }>();
  nameStatusOutput.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cols = trimmed.split(/\s+/);
    if (cols.length >= 2) {
      const code = cols[0][0].toUpperCase() as GitChangedFile['change_type'];
      if (code === 'R' && cols.length >= 3) {
        statusMap.set(cols[2], { type: 'R', oldPath: cols[1] });
      } else {
        statusMap.set(cols[1], { type: code });
      }
    }
  });

  const changedFiles: GitChangedFile[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;

  const lines = numstatOutput.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
      const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
      const filepath = parts.slice(2).join(' ');

      const fileStatus = statusMap.get(filepath) || { type: 'M' as const };
      totalAdded += added;
      totalDeleted += deleted;

      // Extract blame author if possible
      let blameAuthor = commitInfo.author;
      try {
        if (fileStatus.type !== 'D') {
          const { stdout: blameOut } = await runGit(
            ['log', '-1', '--format=%an', `${fullHash}^..${fullHash}`, '--', filepath],
            repoPath
          );
          if (blameOut.trim()) {
            blameAuthor = blameOut.trim();
          }
        }
      } catch {
        // Fall back to commit author
      }

      changedFiles.push({
        filepath,
        change_type: fileStatus.type,
        lines_added: added,
        lines_deleted: deleted,
        old_filepath: fileStatus.oldPath,
        blame_author: blameAuthor
      });
    }
  }

  return {
    commit: commitInfo,
    changed_files: changedFiles,
    total_lines_added: totalAdded,
    total_lines_deleted: totalDeleted
  };
}
