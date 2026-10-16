import path from 'path';
import fs from 'fs';

export interface CommitRecord {
  commit_hash: string;
  short_hash?: string;
  author: string;
  author_email: string;
  timestamp: string;
  message: string;
  branch: string;
  analyzed_at: string;
  lines_added: number;
  lines_deleted: number;
  risk_score: number;
  risk_level: 'High' | 'Medium' | 'Low';
  risk_breakdown: any;
  status: string;
  is_demo?: boolean;
  source?: 'live_git' | 'live_upload' | 'demo_fixture';
  changed_files_count?: number;
  affected_files_count?: number;
  total_tests?: number;
  passed_tests?: number;
  failed_tests?: number;
  context_id?: string;
}

export interface ChangedFileRecord {
  id?: number;
  commit_hash: string;
  filepath: string;
  change_type: string;
  lines_added: number;
  lines_deleted: number;
  blame_author: string;
  context_id?: string;
}

export interface AffectedFileRecord {
  id?: number;
  commit_hash: string;
  filepath: string;
  depth: number;
  reason: string;
  context_id?: string;
}

export interface DependencyEdgeRecord {
  id?: number;
  commit_hash?: string;
  source_file: string;
  target_file: string;
  dep_type: string;
  context_id?: string;
}

export interface TestRunRecord {
  id?: number;
  commit_hash: string;
  test_file: string;
  test_name: string;
  status: 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED';
  duration_sec: number;
  error_message: string;
  stdout: string;
  run_at?: string;
  context_id?: string;
}

export interface AuditLogRecord {
  id?: number;
  commit_hash: string;
  stage: string;
  message: string;
  metadata_json?: string;
  timestamp: string;
  context_id?: string;
}

export interface AnalysisContext {
  id: string;
  name: string;
  type: 'git' | 'upload' | 'demo';
  workspaceDir: string;
  createdAt: string;
  commits: CommitRecord[];
  changed_files: ChangedFileRecord[];
  affected_files: AffectedFileRecord[];
  dependency_edges: DependencyEdgeRecord[];
  test_runs: TestRunRecord[];
  audit_logs: AuditLogRecord[];
}

export class AnalysisStore {
  private contexts: Map<string, AnalysisContext> = new Map();
  private activeContextId: string = 'demo_default';

  constructor() {
    this.initDemoFixture();
  }

  private initDemoFixture() {
    const demoContext: AnalysisContext = {
      id: 'demo_default',
      name: 'Demonstration Fixture (Sample Project)',
      type: 'demo',
      workspaceDir: process.cwd(),
      createdAt: '2026-09-07 09:36:39',
      commits: [],
      changed_files: [],
      affected_files: [],
      dependency_edges: [],
      test_runs: [],
      audit_logs: []
    };

    try {
      const dataPath = path.join(process.cwd(), 'initial_data.json');
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        const parsed = JSON.parse(raw);
        demoContext.commits = (parsed.commits || []).map((c: any) => ({
          ...c,
          is_demo: true,
          source: 'demo_fixture' as const,
          context_id: 'demo_default'
        }));
        demoContext.changed_files = (parsed.changed_files || []).map((cf: any) => ({
          ...cf,
          context_id: 'demo_default'
        }));
        demoContext.affected_files = (parsed.affected_files || []).map((af: any) => ({
          ...af,
          context_id: 'demo_default'
        }));
        demoContext.dependency_edges = (parsed.dependency_edges || []).map((de: any) => ({
          ...de,
          context_id: 'demo_default'
        }));
        demoContext.test_runs = (parsed.test_runs || []).map((tr: any) => ({
          ...tr,
          context_id: 'demo_default'
        }));
        demoContext.audit_logs = (parsed.audit_logs || []).map((al: any) => ({
          ...al,
          context_id: 'demo_default'
        }));
      }
    } catch (e) {
      console.warn('[CodeGuard Store] Demo initial_data.json load warning:', e);
    }

    this.contexts.set('demo_default', demoContext);
  }

  public getContext(contextId?: string): AnalysisContext {
    const targetId = contextId || this.activeContextId;
    if (!this.contexts.has(targetId)) {
      return this.contexts.get('demo_default')!;
    }
    return this.contexts.get(targetId)!;
  }

  public getActiveContextId(): string {
    return this.activeContextId;
  }

  public setActiveContextId(id: string): void {
    if (this.contexts.has(id)) {
      this.activeContextId = id;
    }
  }

  public createContext(id: string, name: string, type: 'git' | 'upload', workspaceDir: string): AnalysisContext {
    const ctx: AnalysisContext = {
      id,
      name,
      type,
      workspaceDir,
      createdAt: new Date().toISOString(),
      commits: [],
      changed_files: [],
      affected_files: [],
      dependency_edges: [],
      test_runs: [],
      audit_logs: []
    };
    this.contexts.set(id, ctx);
    this.activeContextId = id;
    return ctx;
  }

  public listContexts(): Array<{ id: string; name: string; type: string; commitCount: number; is_active: boolean }> {
    return Array.from(this.contexts.values()).map((ctx) => ({
      id: ctx.id,
      name: ctx.name,
      type: ctx.type,
      commitCount: ctx.commits.length,
      is_active: ctx.id === this.activeContextId
    }));
  }

  public getAllCommits(contextId?: string): CommitRecord[] {
    const ctx = this.getContext(contextId);
    return ctx.commits.map((c) => {
      const changedCount = ctx.changed_files.filter((cf) => cf.commit_hash === c.commit_hash).length;
      const affectedCount = ctx.affected_files.filter((af) => af.commit_hash === c.commit_hash).length;
      const tests = ctx.test_runs.filter((tr) => tr.commit_hash === c.commit_hash);
      const passedTests = tests.filter((tr) => tr.status === 'PASSED').length;
      const failedTests = tests.filter((tr) => tr.status === 'FAILED' || tr.status === 'ERROR').length;

      let rb = c.risk_breakdown;
      if (typeof rb === 'string') {
        try {
          rb = JSON.parse(rb);
        } catch {
          rb = {};
        }
      }

      return {
        ...c,
        risk_breakdown: rb,
        changed_files_count: changedCount > 0 ? changedCount : (c.changed_files_count ?? 1),
        affected_files_count: affectedCount,
        total_tests: tests.length,
        passed_tests: passedTests,
        failed_tests: failedTests
      };
    });
  }

  public findCommit(hash: string, contextId?: string): CommitRecord | undefined {
    if (!hash) return undefined;
    const ctx = this.getContext(contextId);
    const target = hash.trim().toLowerCase();
    return ctx.commits.find(
      (c) => c.commit_hash.toLowerCase() === target || c.commit_hash.toLowerCase().startsWith(target)
    );
  }

  public getCommitDetails(commitHash: string, contextId?: string) {
    const ctx = this.getContext(contextId);
    const commit = this.findCommit(commitHash, contextId);
    if (!commit) return null;

    const actualHash = commit.commit_hash;
    let rb = commit.risk_breakdown;
    if (typeof rb === 'string') {
      try {
        rb = JSON.parse(rb);
      } catch {
        rb = {};
      }
    }

    const changed = ctx.changed_files
      .filter((cf) => cf.commit_hash === actualHash)
      .sort((a, b) => a.filepath.localeCompare(b.filepath));

    const affected = ctx.affected_files
      .filter((af) => af.commit_hash === actualHash)
      .sort((a, b) => a.depth - b.depth || a.filepath.localeCompare(b.filepath));

    const edges = ctx.dependency_edges.filter((de) => !de.commit_hash || de.commit_hash === actualHash);

    const tests = ctx.test_runs
      .filter((tr) => tr.commit_hash === actualHash)
      .sort((a, b) => b.status.localeCompare(a.status) || a.test_name.localeCompare(b.test_name));

    const logs = ctx.audit_logs
      .filter((al) => al.commit_hash === actualHash)
      .sort((a, b) => (a.id || 0) - (b.id || 0) || a.timestamp.localeCompare(b.timestamp));

    const total = tests.length;
    const passed = tests.filter((t) => t.status === 'PASSED').length;
    const failed = tests.filter((t) => t.status === 'FAILED' || t.status === 'ERROR').length;
    const skipped = tests.filter((t) => t.status === 'SKIPPED').length;

    return {
      context: {
        id: ctx.id,
        name: ctx.name,
        type: ctx.type,
        is_demo: commit.is_demo || ctx.type === 'demo'
      },
      commit: {
        ...commit,
        risk_breakdown: rb
      },
      changed_files: changed,
      affected_files: affected,
      dependency_edges: edges,
      test_runs: {
        list: tests,
        total,
        passed,
        failed,
        skipped,
        all_passed: total > 0 && failed === 0
      },
      audit_logs: logs
    };
  }

  public addCommitAnalysis(
    contextId: string,
    commit: CommitRecord,
    changedFiles: ChangedFileRecord[],
    affectedFiles: AffectedFileRecord[],
    dependencyEdges: DependencyEdgeRecord[],
    testRuns: TestRunRecord[],
    auditLogs: AuditLogRecord[]
  ) {
    const ctx = this.getContext(contextId);
    // Replace commit if already analyzed, otherwise add
    const existingIdx = ctx.commits.findIndex((c) => c.commit_hash === commit.commit_hash);
    if (existingIdx >= 0) {
      ctx.commits[existingIdx] = commit;
    } else {
      ctx.commits.unshift(commit);
    }

    // Filter out old records for this commit
    ctx.changed_files = ctx.changed_files.filter((cf) => cf.commit_hash !== commit.commit_hash);
    ctx.affected_files = ctx.affected_files.filter((af) => af.commit_hash !== commit.commit_hash);
    ctx.test_runs = ctx.test_runs.filter((tr) => tr.commit_hash !== commit.commit_hash);
    ctx.audit_logs = ctx.audit_logs.filter((al) => al.commit_hash !== commit.commit_hash);

    ctx.changed_files.push(...changedFiles);
    ctx.affected_files.push(...affectedFiles);
    ctx.dependency_edges.push(...dependencyEdges);
    ctx.test_runs.push(...testRuns);
    ctx.audit_logs.push(...auditLogs);
  }
}

export const globalStore = new AnalysisStore();
