import path from 'path';
import fs from 'fs';

export interface DependencyEdge {
  id?: number;
  commit_hash?: string;
  source_file: string; // The file that contains the import statement
  target_file: string; // The file being imported (the dependency)
  dep_type: 'import' | 'require' | 'export_from' | 'type_import';
}

export interface DependencyGraph {
  nodes: string[];
  edges: DependencyEdge[];
  // Mapping from target to all sources that import it (downstream dependents)
  dependentsMap: Record<string, string[]>;
  // Mapping from source to all targets it imports (upstream dependencies)
  dependenciesMap: Record<string, string[]>;
}

export interface BlastRadiusResult {
  rootFile: string;
  directDependents: string[];
  transitiveBlastRadius: string[];
  allImpactedFiles: string[]; // rootFile + transitiveBlastRadius
  hasCycle: boolean;
  depthMap: Record<string, number>;
}

// Built-in modules to ignore
const PYTHON_BUILTINS = new Set([
  'os', 'sys', 'time', 'datetime', 'math', 'random', 'json', 're', 'subprocess',
  'pathlib', 'typing', 'collections', 'itertools', 'functools', 'copy', 'io',
  'shutil', 'tempfile', 'unittest', 'pytest', 'logging', 'argparse', 'hashlib',
  'urllib', 'http', 'socket', 'threading', 'multiprocessing', 'concurrent',
  'asyncio', 'contextlib', 'inspect', 'abc', 'dataclasses', 'enum', 'uuid',
  'sqlite3', 'pickle', 'csv', 'warnings', 'traceback'
]);

const JS_BUILTINS = new Set([
  'fs', 'path', 'os', 'child_process', 'util', 'http', 'https', 'events',
  'stream', 'crypto', 'buffer', 'url', 'querystring', 'assert', 'constants',
  'cluster', 'dgram', 'dns', 'net', 'readline', 'tls', 'v8', 'vm', 'zlib',
  'express', 'react', 'react-dom', 'ejs', 'multer', 'typescript', 'esbuild',
  'tsx', 'mocha', 'jest', 'vitest', 'lodash', 'axios'
]);

/**
 * Extracts import references from Python source code.
 */
function extractPythonImports(content: string): Array<{ rawModule: string; isRelative: boolean; relativeLevel: number }> {
  const imports: Array<{ rawModule: string; isRelative: boolean; relativeLevel: number }> = [];

  // Match: import x, y.z (on a single line)
  const importRegex = /^[^\S\r\n]*import[^\S\r\n]+([a-zA-Z0-9_., \t]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const rawList = match[1].split(',');
    for (const item of rawList) {
      const mod = item.trim().split(/\s+as\s+/)[0].trim();
      if (mod) {
        imports.push({ rawModule: mod, isRelative: false, relativeLevel: 0 });
      }
    }
  }

  // Match: from (.+) import ...
  const fromImportRegex = /^[^\S\r\n]*from[^\S\r\n]+([a-zA-Z0-9_.]+)[^\S\r\n]+import[^\S\r\n]+([a-zA-Z0-9_., \t*]+)/gm;
  while ((match = fromImportRegex.exec(content)) !== null) {
    const raw = match[1].trim();
    if (raw.startsWith('.')) {
      // Relative import: count leading dots
      const dotsMatch = raw.match(/^\.+/);
      const level = dotsMatch ? dotsMatch[0].length : 1;
      const sub = raw.replace(/^\.+/, '');
      imports.push({ rawModule: sub, isRelative: true, relativeLevel: level });
    } else {
      imports.push({ rawModule: raw, isRelative: false, relativeLevel: 0 });
    }
  }

  // Match: from . import x, y
  const fromDotImportRegex = /^[^\S\r\n]*from[^\S\r\n]+(\.+)[^\S\r\n]+import[^\S\r\n]+([a-zA-Z0-9_., \t*]+)/gm;
  while ((match = fromDotImportRegex.exec(content)) !== null) {
    const dots = match[1];
    const items = match[2].split(',');
    for (const item of items) {
      const name = item.trim().split(/\s+as\s+/)[0].trim();
      if (name) {
        imports.push({ rawModule: name, isRelative: true, relativeLevel: dots.length });
      }
    }
  }

  return imports;
}

/**
 * Extracts import references from JS/TS source code.
 */
function extractJsTsImports(content: string): Array<{ rawPath: string; depType: DependencyEdge['dep_type'] }> {
  const results: Array<{ rawPath: string; depType: DependencyEdge['dep_type'] }> = [];

  // static import: import ... from '...'
  const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\w*$,{}]+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const p = match[1].trim();
    const isType = match[0].includes('import type') || match[0].includes('export type');
    results.push({ rawPath: p, depType: isType ? 'type_import' : 'import' });
  }

  // require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    results.push({ rawPath: match[1].trim(), depType: 'require' });
  }

  // dynamic import('...')
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRegex.exec(content)) !== null) {
    results.push({ rawPath: match[1].trim(), depType: 'import' });
  }

  return results;
}

/**
 * Resolves a Python import to a project relative file path if it exists in the project.
 */
function resolvePythonImport(
  importerRelPath: string,
  rawModule: string,
  isRelative: boolean,
  relativeLevel: number,
  allFilesSet: Set<string>
): string | null {
  const importerDir = path.posix.dirname(importerRelPath);

  if (isRelative) {
    // Relative import
    let targetDir = importerDir;
    for (let i = 1; i < relativeLevel; i++) {
      targetDir = path.posix.dirname(targetDir);
    }

    const candidateBase = rawModule
      ? path.posix.join(targetDir, rawModule.replace(/\./g, '/'))
      : targetDir;

    // Check .py file
    if (allFilesSet.has(`${candidateBase}.py`)) return `${candidateBase}.py`;
    // Check package __init__.py
    if (allFilesSet.has(`${candidateBase}/__init__.py`)) return `${candidateBase}/__init__.py`;
    return null;
  }

  // Non-relative import: check built-ins first
  const rootModule = rawModule.split('.')[0];
  if (PYTHON_BUILTINS.has(rootModule)) {
    return null;
  }

  // Try relative to importer dir first (Python implicit relative in same directory)
  const relativeCandidate = path.posix.join(importerDir, rawModule.replace(/\./g, '/'));
  if (allFilesSet.has(`${relativeCandidate}.py`)) return `${relativeCandidate}.py`;
  if (allFilesSet.has(`${relativeCandidate}/__init__.py`)) return `${relativeCandidate}/__init__.py`;

  // Try from project root
  const rootCandidate = rawModule.replace(/\./g, '/');
  if (allFilesSet.has(`${rootCandidate}.py`)) return `${rootCandidate}.py`;
  if (allFilesSet.has(`${rootCandidate}/__init__.py`)) return `${rootCandidate}/__init__.py`;

  // Try subfolders
  for (const f of allFilesSet) {
    if (f.endsWith(`/${rootCandidate}.py`) || f === `${rootCandidate}.py`) {
      return f;
    }
  }

  return null;
}

/**
 * Resolves a JS/TS import path to an actual file in the project.
 */
function resolveJsTsImport(
  importerRelPath: string,
  rawPath: string,
  allFilesSet: Set<string>
): string | null {
  // Ignore bare imports that aren't relative unless they map to local files
  if (!rawPath.startsWith('.') && !rawPath.startsWith('/')) {
    if (JS_BUILTINS.has(rawPath.split('/')[0])) {
      return null;
    }
    // Check if it's an alias or root-relative path
    const directCandidate = rawPath.replace(/^\/+/, '');
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      const candidate = `${directCandidate}${ext}`;
      if (allFilesSet.has(candidate)) return candidate;
    }
    return null;
  }

  const importerDir = path.posix.dirname(importerRelPath);
  const resolvedBase = path.posix.normalize(path.posix.join(importerDir, rawPath));

  // Check extensions
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];
  for (const ext of extensions) {
    const candidate = `${resolvedBase}${ext}`;
    if (allFilesSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Builds a dynamic dependency graph by scanning project files.
 * @param files Array of { relativePath, content }
 */
export function buildDependencyGraph(
  files: Array<{ relativePath: string; content?: string }>
): DependencyGraph {
  const allFilesSet = new Set<string>();
  const filesMap = new Map<string, string>();

  files.forEach((f) => {
    const norm = f.relativePath.replace(/\\/g, '/');
    allFilesSet.add(norm);
    if (f.content !== undefined) {
      filesMap.set(norm, f.content);
    }
  });

  const edges: DependencyEdge[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (source: string, target: string, dep_type: DependencyEdge['dep_type']) => {
    if (source === target) return; // ignore self-dependency
    const key = `${source}->${target}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({
        source_file: source,
        target_file: target,
        dep_type
      });
    }
  };

  for (const relPath of allFilesSet) {
    const ext = path.posix.extname(relPath).toLowerCase();
    const content = filesMap.get(relPath);
    if (!content) continue;

    if (ext === '.py') {
      const imports = extractPythonImports(content);
      for (const imp of imports) {
        const target = resolvePythonImport(relPath, imp.rawModule, imp.isRelative, imp.relativeLevel, allFilesSet);
        if (target) {
          addEdge(relPath, target, 'import');
        }
      }
    } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const imports = extractJsTsImports(content);
      for (const imp of imports) {
        const target = resolveJsTsImport(relPath, imp.rawPath, allFilesSet);
        if (target) {
          addEdge(relPath, target, imp.depType);
        }
      }
    }
  }

  // Construct lookup maps
  const dependentsMap: Record<string, string[]> = {};
  const dependenciesMap: Record<string, string[]> = {};

  allFilesSet.forEach((node) => {
    dependentsMap[node] = [];
    dependenciesMap[node] = [];
  });

  edges.forEach((e) => {
    // e.source_file imports e.target_file
    // e.target_file is imported by e.source_file (so source_file is a dependent of target_file)
    if (!dependentsMap[e.target_file]) dependentsMap[e.target_file] = [];
    dependentsMap[e.target_file].push(e.source_file);

    if (!dependenciesMap[e.source_file]) dependenciesMap[e.source_file] = [];
    dependenciesMap[e.source_file].push(e.target_file);
  });

  return {
    nodes: Array.from(allFilesSet).sort(),
    edges,
    dependentsMap,
    dependenciesMap
  };
}

/**
 * Calculates direct dependents and transitive blast radius for a given root file.
 * Handles cycles safely using a visited set.
 */
export function calculateBlastRadius(
  rootFile: string,
  graph: DependencyGraph
): BlastRadiusResult {
  const directDependents = graph.dependentsMap[rootFile] || [];
  const transitiveVisited = new Set<string>();
  const depthMap: Record<string, number> = { [rootFile]: 0 };
  let hasCycle = false;

  // Queue of [file, depth]
  const queue: Array<[string, number]> = [];
  for (const dep of directDependents) {
    queue.push([dep, 1]);
    depthMap[dep] = 1;
    transitiveVisited.add(dep);
  }

  while (queue.length > 0) {
    const [currentFile, currentDepth] = queue.shift()!;
    const nextDependents = graph.dependentsMap[currentFile] || [];

    for (const next of nextDependents) {
      if (next === rootFile) {
        hasCycle = true;
        continue;
      }
      if (!transitiveVisited.has(next)) {
        transitiveVisited.add(next);
        depthMap[next] = currentDepth + 1;
        queue.push([next, currentDepth + 1]);
      } else {
        // Already visited through another path, potential diamond or cycle
      }
    }
  }

  const transitiveBlastRadius = Array.from(transitiveVisited);
  const allImpactedFiles = [rootFile, ...transitiveBlastRadius];

  return {
    rootFile,
    directDependents: [...directDependents],
    transitiveBlastRadius,
    allImpactedFiles,
    hasCycle,
    depthMap
  };
}

/**
 * Calculate multi-root blast radius for a list of changed files.
 */
export function calculateCombinedBlastRadius(
  changedFiles: string[],
  graph: DependencyGraph
): {
  impactedFiles: string[];
  affectedFilesList: Array<{ filepath: string; depth: number; reason: string }>;
  maxDepth: number;
} {
  const allImpacted = new Set<string>(changedFiles);
  const depthMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();

  changedFiles.forEach((cf) => {
    depthMap.set(cf, 0);
    reasonMap.set(cf, 'Directly modified source file in baseline change');
  });

  const queue: Array<[string, number]> = changedFiles.map((cf) => [cf, 0]);

  while (queue.length > 0) {
    const [curr, depth] = queue.shift()!;
    const dependents = graph.dependentsMap[curr] || [];

    for (const dep of dependents) {
      const nextDepth = depth + 1;
      if (!allImpacted.has(dep)) {
        allImpacted.add(dep);
        depthMap.set(dep, nextDepth);
        reasonMap.set(
          dep,
          nextDepth === 1
            ? `Directly imports modified file "${curr}"`
            : `Transitive dependent at depth ${nextDepth} through "${curr}"`
        );
        queue.push([dep, nextDepth]);
      }
    }
  }

  let maxDepth = 0;
  const affectedFilesList: Array<{ filepath: string; depth: number; reason: string }> = [];

  for (const file of allImpacted) {
    if (!changedFiles.includes(file)) {
      const d = depthMap.get(file) || 1;
      if (d > maxDepth) maxDepth = d;
      affectedFilesList.push({
        filepath: file,
        depth: d,
        reason: reasonMap.get(file) || `Dependent module (depth ${d})`
      });
    }
  }

  affectedFilesList.sort((a, b) => a.depth - b.depth || a.filepath.localeCompare(b.filepath));

  return {
    impactedFiles: Array.from(allImpacted),
    affectedFilesList,
    maxDepth
  };
}
