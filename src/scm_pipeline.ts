import path from 'path';
import fs from 'fs';
import { getGitRepoStatus, getRealGitCommits, getRealCommitChanges, GitCommitInfo } from './scm_engine.js';
import { buildDependencyGraph, calculateCombinedBlastRadius, DependencyGraph } from './dependency_analyzer.js';
import { selectRegressionTests, executeSelectedTests, TestExecutionRecord } from './test_runner.js';
import { calculateDeterministicRisk, RiskAnalysisOutput } from './risk_calculator.js';
import { globalStore, CommitRecord, ChangedFileRecord, AffectedFileRecord, DependencyEdgeRecord } from './analysis_store.js';

export interface AnalysisPipelineOptions {
  repoPath: string;
  commitHash: string;
  contextId?: string;
  runTests?: boolean;
}

export interface PipelineExecutionResult {
  status: 'success' | 'error';
  message?: string;
  is_demo: boolean;
  commit: CommitRecord;
  changed_files: ChangedFileRecord[];
  affected_files: AffectedFileRecord[];
  dependency_edges: DependencyEdgeRecord[];
  test_runs: {
    list: TestExecutionRecord[];
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    all_passed: boolean;
  };
  risk: RiskAnalysisOutput;
  rts_summary: {
    selected_tests_count: number;
    unselected_tests_count: number;
    efficiency_percent: number;
  };
}

/**
 * Scans all source and test files in the workspace directory.
 */
function scanWorkspaceFiles(dir: string, baseDir: string = dir): Array<{ relativePath: string; content?: string }> {
  const result: Array<{ relativePath: string; content?: string }> = [];
  if (!fs.existsSync(dir)) return result;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // Skip hidden / build dirs
      if (
        ['.git', 'node_modules', '__pycache__', '.pytest_cache', 'dist', 'build', '.venv', 'venv'].includes(entry.name)
      ) {
        continue;
      }
      result.push(...scanWorkspaceFiles(full, baseDir));
    } else if (entry.isFile()) {
      const ext = path.posix.extname(rel).toLowerCase();
      if (['.py', '.ts', '.tsx', '.js', '.jsx', '.json', '.md'].includes(ext)) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          result.push({ relativePath: rel, content });
        } catch {
          result.push({ relativePath: rel });
        }
      }
    }
  }

  return result;
}

/**
 * Executes the complete real SCM analysis pipeline for a repository and commit.
 * Never fabricates commits, dependencies, or test runs.
 */
export async function runScmPipeline(options: AnalysisPipelineOptions): Promise<PipelineExecutionResult> {
  const { repoPath, commitHash, runTests = true } = options;
  const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // 1. Verify Git status
  const gitStatus = await getGitRepoStatus(repoPath);
  if (!gitStatus.is_git) {
    throw new Error(`Repository path "${repoPath}" is not a valid Git repository.`);
  }

  // 2. Read genuine commit changes from Git
  const { commit: commitInfo, changed_files: gitChangedFiles, total_lines_added, total_lines_deleted } =
    await getRealCommitChanges(repoPath, commitHash);

  const changedFilesList = gitChangedFiles.map((f) => f.filepath);

  // 3. Scan workspace files to build source dependency graph
  const workspaceFiles = scanWorkspaceFiles(repoPath);
  const dependencyGraph = buildDependencyGraph(workspaceFiles);

  // 4. Calculate real direct dependents and transitive blast radius
  const blastRadius = calculateCombinedBlastRadius(changedFilesList, dependencyGraph);

  // 5. Query historical test failures from store to factor into risk
  const historicalFailingFiles: string[] = [];
  const existingCommits = globalStore.getAllCommits(options.contextId);
  const existingRuns = globalStore.getContext(options.contextId).test_runs;
  existingRuns.forEach((tr) => {
    if (tr.status === 'FAILED' || tr.status === 'ERROR') {
      if (!historicalFailingFiles.includes(tr.test_file)) {
        historicalFailingFiles.push(tr.test_file);
      }
    }
  });

  // 6. Calculate deterministic, explainable risk score
  const riskAnalysis = calculateDeterministicRisk({
    changedFiles: gitChangedFiles,
    affectedFiles: blastRadius.affectedFilesList,
    totalLinesAdded: total_lines_added,
    totalLinesDeleted: total_lines_deleted,
    historicalFailingFiles
  });

  // 7. Perform Regression Test Selection (RTS)
  const allWorkspaceRelPaths = workspaceFiles.map((f) => f.relativePath);
  const rtsSelection = selectRegressionTests(
    changedFilesList,
    blastRadius.impactedFiles,
    allWorkspaceRelPaths,
    dependencyGraph
  );

  // 8. Execute genuine selected tests
  let testRecords: TestExecutionRecord[] = [];
  if (runTests && rtsSelection.selectedTests.length > 0) {
    const testFilePaths = rtsSelection.selectedTests.map((t) => t.testFile);
    const execution = await executeSelectedTests(repoPath, testFilePaths);
    testRecords = execution.records;
  }

  const passedTests = testRecords.filter((t) => t.status === 'PASSED').length;
  const failedTests = testRecords.filter((t) => t.status === 'FAILED' || t.status === 'ERROR').length;
  const skippedTests = testRecords.filter((t) => t.status === 'SKIPPED').length;

  // 9. Prepare store records
  const contextId = options.contextId || 'live_git_context';
  if (!globalStore.listContexts().some((c) => c.id === contextId)) {
    globalStore.createContext(contextId, `Live Git Repository (${path.basename(repoPath)})`, 'git', repoPath);
  }

  const commitRecord: CommitRecord = {
    commit_hash: commitInfo.commit_hash,
    short_hash: commitInfo.short_hash,
    author: commitInfo.author,
    author_email: commitInfo.author_email,
    timestamp: commitInfo.timestamp,
    message: commitInfo.message,
    branch: commitInfo.branch,
    analyzed_at: nowStr,
    lines_added: total_lines_added,
    lines_deleted: total_lines_deleted,
    risk_score: riskAnalysis.total_score,
    risk_level: riskAnalysis.risk_level,
    risk_breakdown: riskAnalysis,
    status: 'COMPLETED',
    is_demo: false,
    source: 'live_git',
    changed_files_count: gitChangedFiles.length,
    affected_files_count: blastRadius.affectedFilesList.length,
    total_tests: testRecords.length,
    passed_tests: passedTests,
    failed_tests: failedTests,
    context_id: contextId
  };

  const changedRecords: ChangedFileRecord[] = gitChangedFiles.map((cf) => ({
    commit_hash: commitInfo.commit_hash,
    filepath: cf.filepath,
    change_type: cf.change_type,
    lines_added: cf.lines_added,
    lines_deleted: cf.lines_deleted,
    blame_author: cf.blame_author || commitInfo.author,
    context_id: contextId
  }));

  const affectedRecords: AffectedFileRecord[] = blastRadius.affectedFilesList.map((af) => ({
    commit_hash: commitInfo.commit_hash,
    filepath: af.filepath,
    depth: af.depth,
    reason: af.reason,
    context_id: contextId
  }));

  const edgeRecords: DependencyEdgeRecord[] = dependencyGraph.edges.map((e) => ({
    commit_hash: commitInfo.commit_hash,
    source_file: e.source_file,
    target_file: e.target_file,
    dep_type: e.dep_type,
    context_id: contextId
  }));

  const testRunRecords = testRecords.map((tr) => ({
    commit_hash: commitInfo.commit_hash,
    test_file: tr.test_file,
    test_name: tr.test_name,
    status: tr.status,
    duration_sec: tr.duration_sec,
    error_message: tr.error_message,
    stdout: tr.stdout,
    run_at: tr.run_at,
    context_id: contextId
  }));

  const auditRecords = [
    {
      commit_hash: commitInfo.commit_hash,
      stage: 'GIT_METADATA_EXTRACTION',
      message: `Parsed live Git commit ${commitInfo.short_hash} by ${commitInfo.author}`,
      timestamp: nowStr,
      context_id: contextId
    },
    {
      commit_hash: commitInfo.commit_hash,
      stage: 'AST_DEPENDENCY_ANALYSIS',
      message: `Mapped ${dependencyGraph.edges.length} source dependency edges across ${dependencyGraph.nodes.length} files`,
      timestamp: nowStr,
      context_id: contextId
    },
    {
      commit_hash: commitInfo.commit_hash,
      stage: 'BLAST_RADIUS_COMPUTATION',
      message: `Identified ${blastRadius.affectedFilesList.length} affected modules (max transitive depth: ${blastRadius.maxDepth})`,
      timestamp: nowStr,
      context_id: contextId
    },
    {
      commit_hash: commitInfo.commit_hash,
      stage: 'RTS_SELECTION',
      message: `Selected ${rtsSelection.selectedTests.length} of ${rtsSelection.totalTestSuiteCount} tests (${rtsSelection.selectionEfficiencyPercent}% minimization efficiency)`,
      timestamp: nowStr,
      context_id: contextId
    },
    {
      commit_hash: commitInfo.commit_hash,
      stage: 'RISK_QUANTIFICATION',
      message: `Computed deterministic SCM score of ${riskAnalysis.total_score} (${riskAnalysis.risk_level} Risk)`,
      timestamp: nowStr,
      context_id: contextId
    }
  ];

  if (testRecords.length > 0) {
    auditRecords.push({
      commit_hash: commitInfo.commit_hash,
      stage: 'REGRESSION_TEST_EXECUTION',
      message: `Executed ${testRecords.length} tests: ${passedTests} passed, ${failedTests} failed, ${skippedTests} skipped`,
      timestamp: nowStr,
      context_id: contextId
    });
  }

  globalStore.addCommitAnalysis(
    contextId,
    commitRecord,
    changedRecords,
    affectedRecords,
    edgeRecords,
    testRunRecords,
    auditRecords
  );

  return {
    status: 'success',
    is_demo: false,
    commit: commitRecord,
    changed_files: changedRecords,
    affected_files: affectedRecords,
    dependency_edges: edgeRecords,
    test_runs: {
      list: testRecords,
      total: testRecords.length,
      passed: passedTests,
      failed: failedTests,
      skipped: skippedTests,
      all_passed: testRecords.length > 0 && failedTests === 0
    },
    risk: riskAnalysis,
    rts_summary: {
      selected_tests_count: rtsSelection.selectedTests.length,
      unselected_tests_count: rtsSelection.unselectedTests.length,
      efficiency_percent: rtsSelection.selectionEfficiencyPercent
    }
  };
}
