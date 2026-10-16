import { execFile, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { DependencyGraph } from './dependency_analyzer.js';

export interface TestSelectionResult {
  selectedTests: Array<{
    testFile: string;
    targetModule: string;
    selectionReason: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
  unselectedTests: string[];
  totalTestSuiteCount: number;
  selectionEfficiencyPercent: number; // Percentage of tests skipped/saved
}

export interface TestExecutionRecord {
  test_file: string;
  test_name: string;
  status: 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED';
  duration_sec: number;
  error_message: string;
  stdout: string;
  run_at: string;
}

export interface SuiteExecutionSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_sec: number;
  all_passed: boolean;
  records: TestExecutionRecord[];
}

/**
 * Discovers all test files present in a list of project relative paths.
 */
export function discoverTestFiles(allFiles: string[]): string[] {
  return allFiles.filter((f) => {
    const norm = f.replace(/\\/g, '/').toLowerCase();
    const basename = path.posix.basename(norm);
    return (
      basename.startsWith('test_') ||
      basename.endsWith('_test.py') ||
      basename.endsWith('.test.ts') ||
      basename.endsWith('.test.js') ||
      basename.endsWith('.spec.ts') ||
      basename.endsWith('.spec.js') ||
      norm.includes('/tests/') ||
      norm.includes('/test/')
    );
  });
}

/**
 * Selects targeted regression tests for a given set of changed files and transitive impact.
 */
export function selectRegressionTests(
  changedFiles: string[],
  allImpactedFiles: string[],
  allFiles: string[],
  graph: DependencyGraph
): TestSelectionResult {
  const allTests = discoverTestFiles(allFiles);
  const selectedMap = new Map<
    string,
    { testFile: string; targetModule: string; selectionReason: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' }
  >();

  const changedSet = new Set(changedFiles);
  const impactedSet = new Set(allImpactedFiles);

  for (const testFile of allTests) {
    const testNorm = testFile.replace(/\\/g, '/');
    const testDependencies = graph.dependenciesMap[testNorm] || [];
    const testBaseName = path.posix.basename(testNorm).toLowerCase();

    // 1. Direct import of a changed file (Highest Priority)
    let matchedDirect = false;
    for (const dep of testDependencies) {
      if (changedSet.has(dep)) {
        selectedMap.set(testNorm, {
          testFile: testNorm,
          targetModule: dep,
          selectionReason: `Directly imports modified file "${dep}"`,
          priority: 'HIGH'
        });
        matchedDirect = true;
        break;
      }
    }
    if (matchedDirect) continue;

    // 2. Direct import of an affected downstream file (Medium Priority)
    let matchedTransitive = false;
    for (const dep of testDependencies) {
      if (impactedSet.has(dep)) {
        selectedMap.set(testNorm, {
          testFile: testNorm,
          targetModule: dep,
          selectionReason: `Imports affected downstream module "${dep}" in blast radius`,
          priority: 'MEDIUM'
        });
        matchedTransitive = true;
        break;
      }
    }
    if (matchedTransitive) continue;

    // 3. Naming convention match (e.g. test_login.py matches login.py)
    for (const cf of changedFiles) {
      const cfBase = path.posix.basename(cf).replace(/\.[^.]+$/, '').toLowerCase();
      if (
        testBaseName === `test_${cfBase}.py` ||
        testBaseName === `${cfBase}_test.py` ||
        testBaseName === `${cfBase}.test.ts` ||
        testBaseName === `${cfBase}.test.js` ||
        testBaseName === `${cfBase}.spec.ts` ||
        testBaseName === `${cfBase}.spec.js`
      ) {
        selectedMap.set(testNorm, {
          testFile: testNorm,
          targetModule: cf,
          selectionReason: `Test suite named for changed file "${cf}"`,
          priority: 'HIGH'
        });
        break;
      }
    }
  }

  const selectedTests = Array.from(selectedMap.values()).sort((a, b) => {
    if (a.priority === 'HIGH' && b.priority !== 'HIGH') return -1;
    if (a.priority !== 'HIGH' && b.priority === 'HIGH') return 1;
    return a.testFile.localeCompare(b.testFile);
  });

  const selectedSet = new Set(selectedTests.map((t) => t.testFile));
  const unselectedTests = allTests.filter((t) => !selectedSet.has(t));

  const total = allTests.length;
  const skippedCount = total - selectedTests.length;
  const efficiency = total > 0 ? Math.round((skippedCount / total) * 1000) / 10 : 0;

  return {
    selectedTests,
    unselectedTests,
    totalTestSuiteCount: total,
    selectionEfficiencyPercent: efficiency
  };
}

/**
 * Safely executes a Python test file via unittest or pytest with timeout and isolation.
 */
export async function executePythonTest(
  workspaceDir: string,
  relTestPath: string,
  timeoutMs = 15000
): Promise<TestExecutionRecord[]> {
  const startTime = Date.now();
  const runAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const fullPath = path.resolve(workspaceDir, relTestPath);

  if (!fs.existsSync(fullPath)) {
    return [
      {
        test_file: relTestPath,
        test_name: relTestPath,
        status: 'ERROR',
        duration_sec: 0,
        error_message: `Test file not found on disk: ${relTestPath}`,
        stdout: '',
        run_at: runAt
      }
    ];
  }

  return new Promise((resolve) => {
    // Run python with unbuffered output and isolated PYTHONPATH
    const child = spawn(
      'python3',
      ['-m', 'unittest', '-v', relTestPath],
      {
        cwd: workspaceDir,
        timeout: timeoutMs,
        env: {
          ...process.env,
          PYTHONPATH: `${workspaceDir}:${process.env.PYTHONPATH || ''}`,
          PYTHONDONTWRITEBYTECODE: '1'
        }
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      const durationSec = Math.round(((Date.now() - startTime) / 1000) * 1000) / 1000;
      const combined = (stdout + '\n' + stderr).trim();

      // Parse individual unittest cases from output:
      // e.g. test_something (tests.test_mod.TestCase) ... ok
      // test_other (tests.test_mod.TestCase) ... FAIL
      const records: TestExecutionRecord[] = [];
      const testLineRegex = /^([a-zA-Z0-9_]+)\s+\(([^)]+)\)\s+\.\.\.\s+([A-Z]+|ok|FAIL|ERROR)/gm;
      let match: RegExpExecArray | null;

      while ((match = testLineRegex.exec(combined)) !== null) {
        const testMethod = match[1];
        const testClass = match[2];
        const rawStatus = match[3];

        let status: TestExecutionRecord['status'] = 'PASSED';
        if (rawStatus === 'FAIL' || rawStatus === 'FAILED') {
          status = 'FAILED';
        } else if (rawStatus === 'ERROR') {
          status = 'ERROR';
        } else if (rawStatus === 'SKIPPED' || rawStatus.toLowerCase() === 'skipped') {
          status = 'SKIPPED';
        }

        records.push({
          test_file: relTestPath,
          test_name: `${testClass}.${testMethod}`,
          status,
          duration_sec: durationSec,
          error_message: status !== 'PASSED' ? stderr.substring(0, 1000) : '',
          stdout: combined.substring(0, 2000),
          run_at: runAt
        });
      }

      if (records.length === 0) {
        // Fallback if individual regex didn't match
        const isSuccess = code === 0 && !combined.includes('FAILED') && !combined.includes('ERROR');
        records.push({
          test_file: relTestPath,
          test_name: path.posix.basename(relTestPath, path.posix.extname(relTestPath)),
          status: isSuccess ? 'PASSED' : 'FAILED',
          duration_sec: durationSec,
          error_message: isSuccess ? '' : stderr.substring(0, 1000) || `Process exited with code ${code}`,
          stdout: combined.substring(0, 2000),
          run_at: runAt
        });
      }

      resolve(records);
    });

    child.on('error', (err) => {
      const durationSec = Math.round(((Date.now() - startTime) / 1000) * 1000) / 1000;
      resolve([
        {
          test_file: relTestPath,
          test_name: relTestPath,
          status: 'ERROR',
          duration_sec: durationSec,
          error_message: `Execution failed: ${err.message}`,
          stdout: '',
          run_at: runAt
        }
      ]);
    });
  });
}

/**
 * Safely executes a Node.js / TypeScript test file via node --test or tsx.
 */
export async function executeNodeTest(
  workspaceDir: string,
  relTestPath: string,
  timeoutMs = 15000
): Promise<TestExecutionRecord[]> {
  const startTime = Date.now();
  const runAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

  return new Promise((resolve) => {
    const isTs = relTestPath.endsWith('.ts');
    const cmd = isTs ? 'npx' : 'node';
    const args = isTs ? ['tsx', '--test', relTestPath] : ['--test', relTestPath];

    const child = spawn(cmd, args, {
      cwd: workspaceDir,
      timeout: timeoutMs,
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      const durationSec = Math.round(((Date.now() - startTime) / 1000) * 1000) / 1000;
      const combined = (stdout + '\n' + stderr).trim();
      const isSuccess = code === 0 && !combined.includes('fail 1') && !combined.includes('not ok');

      resolve([
        {
          test_file: relTestPath,
          test_name: path.posix.basename(relTestPath, path.posix.extname(relTestPath)),
          status: isSuccess ? 'PASSED' : 'FAILED',
          duration_sec: durationSec,
          error_message: isSuccess ? '' : stderr.substring(0, 1000) || `Process exited with code ${code}`,
          stdout: combined.substring(0, 2000),
          run_at: runAt
        }
      ]);
    });

    child.on('error', (err) => {
      resolve([
        {
          test_file: relTestPath,
          test_name: relTestPath,
          status: 'ERROR',
          duration_sec: Math.round(((Date.now() - startTime) / 1000) * 1000) / 1000,
          error_message: err.message,
          stdout: '',
          run_at: runAt
        }
      ]);
    });
  });
}

/**
 * Executes a list of selected test files sequentially or with concurrency control.
 */
export async function executeSelectedTests(
  workspaceDir: string,
  testFiles: string[]
): Promise<SuiteExecutionSummary> {
  const startTime = Date.now();
  const allRecords: TestExecutionRecord[] = [];

  for (const testFile of testFiles) {
    const ext = path.posix.extname(testFile).toLowerCase();
    let records: TestExecutionRecord[] = [];

    if (ext === '.py') {
      records = await executePythonTest(workspaceDir, testFile);
    } else if (['.ts', '.js', '.mjs'].includes(ext)) {
      records = await executeNodeTest(workspaceDir, testFile);
    } else {
      records = [
        {
          test_file: testFile,
          test_name: testFile,
          status: 'SKIPPED',
          duration_sec: 0,
          error_message: `Unsupported test file extension "${ext}"`,
          stdout: '',
          run_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
        }
      ];
    }

    allRecords.push(...records);
  }

  const passed = allRecords.filter((r) => r.status === 'PASSED').length;
  const failed = allRecords.filter((r) => r.status === 'FAILED' || r.status === 'ERROR').length;
  const skipped = allRecords.filter((r) => r.status === 'SKIPPED').length;
  const totalDuration = Math.round(((Date.now() - startTime) / 1000) * 1000) / 1000;

  return {
    total: allRecords.length,
    passed,
    failed,
    skipped,
    duration_sec: totalDuration,
    all_passed: allRecords.length > 0 && failed === 0,
    records: allRecords
  };
}
