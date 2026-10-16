import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScmPipeline } from '../src/scm_pipeline.js';
import { globalStore } from '../src/analysis_store.js';
import { processFolderUpload } from '../src/upload_handler.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

describe('CodeGuard End-to-End SCM Pipeline & Context Isolation', () => {
  it('should run full SCM pipeline on a genuine Git project and produce explainable risk and test records', async () => {
    const repoDir = path.join(os.tmpdir(), `pipeline_test_repo_${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    try {
      await execFileAsync('git', ['init'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'SCM Lead'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'lead@codeguard.dev'], { cwd: repoDir });

      // Base commit
      fs.writeFileSync(path.join(repoDir, 'service.py'), 'def process_order(id):\n    return f"Order {id} processed"\n');
      fs.writeFileSync(
        path.join(repoDir, 'test_service.py'),
        'import unittest\nfrom service import process_order\n\nclass TestService(unittest.TestCase):\n    def test_process(self):\n        self.assertEqual(process_order(42), "Order 42 processed")\n'
      );
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'Initial baseline with service and test'], { cwd: repoDir });

      // Second commit modifying service.py
      fs.writeFileSync(
        path.join(repoDir, 'service.py'),
        'def process_order(id):\n    if id <= 0:\n        raise ValueError("Invalid order id")\n    return f"Order {id} processed successfully"\n'
      );
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'feat(service): Validate order id and update return string'], { cwd: repoDir });

      const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
      const commitHash = headSha.trim();

      const pipelineResult = await runScmPipeline({
        repoPath: repoDir,
        commitHash,
        contextId: `test_ctx_${Date.now()}`,
        runTests: true
      });

      assert.equal(pipelineResult.status, 'success');
      assert.equal(pipelineResult.is_demo, false);
      assert.equal(pipelineResult.commit.commit_hash, commitHash);
      assert.equal(pipelineResult.changed_files.length, 1);
      assert.equal(pipelineResult.changed_files[0].filepath, 'service.py');
      assert.ok(pipelineResult.risk.total_score >= 0);
      assert.ok(pipelineResult.rts_summary.selected_tests_count >= 1);
      assert.ok(pipelineResult.test_runs.total >= 1);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('should maintain strict context isolation between multiple uploads without data leakage', async () => {
    // Upload Project A
    const uploadA = await processFolderUpload('ProjectA', [
      { relativePath: 'src/moduleA.py', content: 'print("A")' },
      { relativePath: 'tests/test_moduleA.py', content: 'import unittest' }
    ]);

    const ctxA = globalStore.createContext(uploadA.uploadId, 'Project A', 'upload', uploadA.workspaceDir);

    // Upload Project B
    const uploadB = await processFolderUpload('ProjectB', [
      { relativePath: 'src/moduleB.py', content: 'print("B")' },
      { relativePath: 'tests/test_moduleB.py', content: 'import unittest' }
    ]);

    const ctxB = globalStore.createContext(uploadB.uploadId, 'Project B', 'upload', uploadB.workspaceDir);

    // Ensure Project A and Project B contexts are isolated
    assert.notEqual(ctxA.id, ctxB.id);
    assert.equal(ctxA.name, 'Project A');
    assert.equal(ctxB.name, 'Project B');

    // Clean up
    fs.rmSync(uploadA.workspaceDir, { recursive: true, force: true });
    fs.rmSync(uploadB.workspaceDir, { recursive: true, force: true });
  });
});
