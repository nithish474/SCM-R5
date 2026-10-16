import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverTestFiles,
  selectRegressionTests,
  executePythonTest,
  executeSelectedTests
} from '../src/test_runner.js';
import { buildDependencyGraph } from '../src/dependency_analyzer.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('CodeGuard RTS and Test Runner', () => {
  it('should discover test files matching standard patterns', () => {
    const files = [
      'src/app.py',
      'src/test_utils.py',
      'tests/test_auth.py',
      'src/payment_test.py',
      'src/index.ts',
      'src/auth.test.ts',
      'src/profile.spec.js',
      'README.md'
    ];

    const discovered = discoverTestFiles(files);
    assert.ok(discovered.includes('src/test_utils.py'));
    assert.ok(discovered.includes('tests/test_auth.py'));
    assert.ok(discovered.includes('src/payment_test.py'));
    assert.ok(discovered.includes('src/auth.test.ts'));
    assert.ok(discovered.includes('src/profile.spec.js'));
    assert.ok(!discovered.includes('src/app.py'));
    assert.ok(!discovered.includes('README.md'));
  });

  it('should select only relevant tests based on direct and transitive dependency impact', () => {
    const files = [
      { relativePath: 'database.py', content: '' },
      { relativePath: 'login.py', content: 'import database' },
      { relativePath: 'unrelated.py', content: '' },
      { relativePath: 'test_database.py', content: 'import database' },
      { relativePath: 'test_login.py', content: 'import login' },
      { relativePath: 'test_unrelated.py', content: 'import unrelated' }
    ];

    const graph = buildDependencyGraph(files);
    const changedFiles = ['database.py'];
    const allImpacted = ['database.py', 'login.py', 'test_database.py'];
    const allFilePaths = files.map((f) => f.relativePath);

    const rts = selectRegressionTests(changedFiles, allImpacted, allFilePaths, graph);

    const selectedNames = rts.selectedTests.map((t) => t.testFile);
    assert.ok(selectedNames.includes('test_database.py'), 'test_database.py directly imports database.py');
    assert.ok(selectedNames.includes('test_login.py'), 'test_login.py imports affected login.py');
    assert.ok(!selectedNames.includes('test_unrelated.py'), 'test_unrelated.py should NOT be selected');
    assert.equal(rts.unselectedTests.length, 1);
    assert.ok(rts.selectionEfficiencyPercent > 0);
  });

  it('should execute real Python unittest in isolated workspace and capture genuine output', async () => {
    // Create temporary workspace
    const tempDir = path.join(os.tmpdir(), `test_exec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // 1. Create a passing test
      const passTestCode = `
import unittest

class SamplePassTest(unittest.TestCase):
    def test_addition(self):
        self.assertEqual(2 + 2, 4)

    def test_truth(self):
        self.assertTrue(True)

if __name__ == '__main__':
    unittest.main()
`;
      fs.writeFileSync(path.join(tempDir, 'test_pass.py'), passTestCode);

      // 2. Create a failing test
      const failTestCode = `
import unittest

class SampleFailTest(unittest.TestCase):
    def test_failure(self):
        self.assertEqual(1, 99, "Expected 1 to equal 99")

if __name__ == '__main__':
    unittest.main()
`;
      fs.writeFileSync(path.join(tempDir, 'test_fail.py'), failTestCode);

      // Execute passing test
      const passRecords = await executePythonTest(tempDir, 'test_pass.py');
      assert.ok(passRecords.length >= 1);
      const allPassed = passRecords.every((r) => r.status === 'PASSED');
      assert.ok(allPassed, 'Passing test should have status PASSED');
      assert.ok(passRecords[0].duration_sec >= 0);

      // Execute failing test
      const failRecords = await executePythonTest(tempDir, 'test_fail.py');
      assert.ok(failRecords.length >= 1);
      const hasFailed = failRecords.some((r) => r.status === 'FAILED');
      assert.ok(hasFailed, 'Failing test should have status FAILED');
      assert.ok(failRecords[0].error_message.includes('AssertionError') || failRecords[0].stdout.includes('FAIL'));

      // Test suite summary execution
      const suiteSummary = await executeSelectedTests(tempDir, ['test_pass.py', 'test_fail.py']);
      assert.equal(suiteSummary.total, passRecords.length + failRecords.length);
      assert.ok(suiteSummary.failed >= 1);
      assert.equal(suiteSummary.all_passed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should honestly return ERROR when test file does not exist', async () => {
    const records = await executePythonTest('/tmp', 'non_existent_test_123.py');
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'ERROR');
    assert.ok(records[0].error_message.includes('not found'));
  });
});
