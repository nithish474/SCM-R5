import path from 'path';
import fs from 'fs';
import os from 'os';

export interface UploadedFileItem {
  relativePath: string;
  content: string; // UTF-8 text or base64
  encoding?: 'utf-8' | 'base64';
  size?: number;
}

export interface ValidatedFileItem {
  relativePath: string;
  absolutePath: string;
  size: number;
  extension: string;
  category: 'source' | 'test' | 'config' | 'doc' | 'other';
}

export interface UploadResult {
  uploadId: string;
  projectName: string;
  workspaceDir: string;
  files: ValidatedFileItem[];
  ignoredFiles: Array<{ path: string; reason: string }>;
  totalFiles: number;
  totalBytes: number;
}

// Explicit Documented Filtering Rules
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
  'bower_components',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  'env',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache'
]);

const IGNORED_FILENAMES = new Set([
  '.ds_store',
  'thumbs.db'
]);

const IGNORED_BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg',
  '.mp4', '.mp3', '.wav', '.mov',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.pyc', '.pyo', '.class', '.o', '.obj'
]);

/**
 * Validates and normalizes relative file paths, rejecting any path traversal or unsafe characters.
 */
export function validateRelativePath(rawPath: string): { valid: boolean; normalizedPath?: string; error?: string } {
  if (!rawPath || typeof rawPath !== 'string') {
    return { valid: false, error: 'Empty or invalid path string' };
  }

  // Reject null bytes
  if (rawPath.includes('\0')) {
    return { valid: false, error: 'Path contains forbidden null byte' };
  }

  // Replace Windows backslashes with POSIX forward slashes
  let p = rawPath.replace(/\\/g, '/').trim();

  // Strip leading slashes or dots
  while (p.startsWith('/') || p.startsWith('./')) {
    p = p.replace(/^(\/|\.\/)/, '');
  }

  // Reject Windows drive letters (e.g., C:/...)
  if (/^[a-zA-Z]:/.test(p)) {
    return { valid: false, error: 'Absolute drive paths are not allowed' };
  }

  // Split into segments and inspect each segment
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { valid: false, error: 'Directory traversal sequence ("..") is strictly forbidden' };
    }
    if (seg === '' && segments.length > 1) {
      // empty segment indicates '//'
      continue;
    }
  }

  // Re-join and normalize
  const normalized = path.posix.normalize(p);
  if (normalized.startsWith('../') || normalized === '..') {
    return { valid: false, error: 'Path traverses outside project root' };
  }

  return { valid: true, normalizedPath: normalized };
}

/**
 * Determine if a relative path should be excluded based on explicit filtering rules.
 */
export function shouldIgnoreFile(relPath: string): { ignore: boolean; reason?: string } {
  const parts = relPath.split('/');
  const filename = parts[parts.length - 1].toLowerCase();

  // Check directory segments
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i];
    if (IGNORED_DIRECTORY_NAMES.has(dir) || IGNORED_DIRECTORY_NAMES.has(dir.toLowerCase())) {
      return { ignore: true, reason: `Excluded directory: ${dir}` };
    }
  }

  // Check filename
  if (IGNORED_FILENAMES.has(filename)) {
    return { ignore: true, reason: `Excluded system file: ${filename}` };
  }

  // Check binary extensions
  const ext = path.posix.extname(filename).toLowerCase();
  if (IGNORED_BINARY_EXTENSIONS.has(ext)) {
    return { ignore: true, reason: `Binary / non-source file format: ${ext}` };
  }

  return { ignore: false };
}

/**
 * Classify file into category
 */
export function categorizeFile(relPath: string): 'source' | 'test' | 'config' | 'doc' | 'other' {
  const lower = relPath.toLowerCase();
  const filename = path.posix.basename(lower);
  const ext = path.posix.extname(lower);

  if (
    filename.startsWith('test_') ||
    filename.endsWith('_test.py') ||
    filename.endsWith('.test.js') ||
    filename.endsWith('.test.ts') ||
    filename.endsWith('.spec.js') ||
    filename.endsWith('.spec.ts') ||
    lower.includes('/tests/') ||
    lower.includes('/test/')
  ) {
    return 'test';
  }

  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.config'].includes(ext)) {
    return 'config';
  }

  if (['.md', '.txt', '.rst', '.doc', '.pdf'].includes(ext) || filename === 'readme' || filename.startsWith('readme.')) {
    return 'doc';
  }

  if (['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.sql', '.html', '.css'].includes(ext)) {
    return 'source';
  }

  return 'other';
}

/**
 * Normalizes a list of paths from webkitRelativePath.
 * If all files share a common root directory (e.g. "my-project/src/a.py", "my-project/README.md"),
 * the outer directory name is stripped so the relative paths are rooted cleanly at project level.
 */
export function normalizeFolderPrefixes(items: UploadedFileItem[]): UploadedFileItem[] {
  if (items.length === 0) return items;

  // Check if every path starts with "<prefix>/"
  const firstSlash = items[0].relativePath.replace(/\\/g, '/').indexOf('/');
  if (firstSlash === -1) {
    return items;
  }

  const candidatePrefix = items[0].relativePath.replace(/\\/g, '/').substring(0, firstSlash + 1);
  const allSharePrefix = items.every(item => item.relativePath.replace(/\\/g, '/').startsWith(candidatePrefix));

  if (allSharePrefix && candidatePrefix.length > 1) {
    return items.map(item => ({
      ...item,
      relativePath: item.relativePath.replace(/\\/g, '/').substring(candidatePrefix.length)
    }));
  }

  return items;
}

/**
 * Processes and saves a folder upload into an isolated workspace directory.
 */
export async function processFolderUpload(
  projectName: string,
  rawItems: UploadedFileItem[]
): Promise<UploadResult> {
  const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const sanitizedProjectName = projectName ? projectName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'project';

  // Isolated workspace path under os.tmpdir()
  const workspaceDir = path.join(os.tmpdir(), 'codeguard_workspaces', uploadId);
  await fs.promises.mkdir(workspaceDir, { recursive: true });

  const normalizedItems = normalizeFolderPrefixes(rawItems);
  const validatedFiles: ValidatedFileItem[] = [];
  const ignoredFiles: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  for (const item of normalizedItems) {
    const valResult = validateRelativePath(item.relativePath);
    if (!valResult.valid || !valResult.normalizedPath) {
      ignoredFiles.push({ path: item.relativePath, reason: valResult.error || 'Invalid path' });
      continue;
    }

    const relPath = valResult.normalizedPath;
    const filterCheck = shouldIgnoreFile(relPath);
    if (filterCheck.ignore) {
      ignoredFiles.push({ path: relPath, reason: filterCheck.reason || 'Filtered' });
      continue;
    }

    // Prepare destination path in workspace
    const absolutePath = path.join(workspaceDir, relPath);
    const dirName = path.dirname(absolutePath);

    // Ensure directory exists
    await fs.promises.mkdir(dirName, { recursive: true });

    // Write file content safely (never execute)
    let buffer: Buffer;
    if (item.encoding === 'base64') {
      buffer = Buffer.from(item.content, 'base64');
    } else {
      buffer = Buffer.from(item.content, 'utf-8');
    }

    await fs.promises.writeFile(absolutePath, buffer);

    const fileSize = buffer.length;
    totalBytes += fileSize;

    validatedFiles.push({
      relativePath: relPath,
      absolutePath,
      size: fileSize,
      extension: path.posix.extname(relPath).toLowerCase(),
      category: categorizeFile(relPath)
    });
  }

  return {
    uploadId,
    projectName: sanitizedProjectName,
    workspaceDir,
    files: validatedFiles,
    ignoredFiles,
    totalFiles: validatedFiles.length,
    totalBytes
  };
}

/**
 * Cleanup isolated workspace when no longer needed
 */
export async function cleanupWorkspace(workspaceDir: string): Promise<void> {
  try {
    if (workspaceDir && workspaceDir.includes('codeguard_workspaces') && fs.existsSync(workspaceDir)) {
      await fs.promises.rm(workspaceDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[CodeGuard] Failed to cleanup workspace ${workspaceDir}:`, err);
  }
}
