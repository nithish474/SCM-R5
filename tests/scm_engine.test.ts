import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGitRepoStatus, getRealGitCommits, getRealCommitChanges } from '../src/scm_engine.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

describe('CodeGuard Real Git SCM Engine', () => {
  it('should detect non-git directory honestly', async () => {
    const tempDir = path.join(os.tmpdir(), `non_git_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      const status = await getGitRepoStatus(tempDir);
      assert.equal(status.is_git, false);
      assert.ok(status.error);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should initialize temporary Git repository, create genuine commits and extract metadata', async () => {
    const repoDir = path.join(os.tmpdir(), `test_git_repo_${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    try {
      // Initialize real git repo
      await execFileAsync('git', ['init'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'Test Engineer'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'test@codeguard.dev'], { cwd: repoDir });

      // Create Commit 1: Initial commit
      fs.writeFileSync(path.join(repoDir, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'feat: Initial commit adding calc.py'], { cwd: repoDir });

      // Create Commit 2: Modify calc.py and add test_calc.py
      fs.appendFileSync(path.join(repoDir, 'calc.py'), 'def multiply(a, b):\n    return a * b\n');
      fs.writeFileSync(
        path.join(repoDir, 'test_calc.py'),
        'import unittest\nfrom calc import add\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n'
      );
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'test: Add multiplication and test_calc.py'], { cwd: repoDir });

      // Verify repo status
      const status = await getGitRepoStatus(repoDir);
      assert.equal(status.is_git, true);
      assert.equal(status.commit_count, 2);
      assert.ok(status.head_commit);

      // Verify git log extraction
      const commits = await getRealGitCommits(repoDir, 10);
      assert.equal(commits.length, 2);
      assert.equal(commits[0].author, 'Test Engineer');
      assert.equal(commits[0].message, 'test: Add multiplication and test_calc.py');

      // Verify commit changes extraction on HEAD
      const headChanges = await getRealCommitChanges(repoDir, commits[0].commit_hash);
      assert.equal(headChanges.commit.commit_hash, commits[0].commit_hash);
      assert.ok(headChanges.changed_files.length >= 2);
      assert.ok(headChanges.total_lines_added > 0);

      const calcChange = headChanges.changed_files.find((f) => f.filepath === 'calc.py');
      assert.ok(calcChange, 'calc.py should be in changed files');
      assert.equal(calcChange?.change_type, 'M');

      const testChange = headChanges.changed_files.find((f) => f.filepath === 'test_calc.py');
      assert.ok(testChange, 'test_calc.py should be in changed files');
      assert.equal(testChange?.change_type, 'A');

      // Verify root commit (Commit 1)
      const rootChanges = await getRealCommitChanges(repoDir, commits[1].commit_hash);
      assert.equal(rootChanges.changed_files.length, 1);
      assert.equal(rootChanges.changed_files[0].filepath, 'calc.py');
      assert.equal(rootChanges.changed_files[0].change_type, 'A');

      // Verify error on non-existent commit (never fabricate!)
      await assert.rejects(
        async () => {
          await getRealCommitChanges(repoDir, 'deadbeef1234567890abcdef1234567890abcdef');
        },
        {
          message: /does not exist/
        }
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
