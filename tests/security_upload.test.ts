import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelativePath, shouldIgnoreFile, categorizeFile } from '../src/upload_handler.js';

describe('CodeGuard Upload Path Validation and Security Rules', () => {
  it('should reject path traversal sequences strictly', () => {
    assert.equal(validateRelativePath('../secret.py').valid, false);
    assert.equal(validateRelativePath('../../etc/passwd').valid, false);
    assert.equal(validateRelativePath('foo/../../bar.py').valid, false);
    assert.equal(validateRelativePath('foo/../bar.py').valid, false);
  });

  it('should reject absolute paths and Windows drive letters', () => {
    assert.equal(validateRelativePath('C:/Windows/System32').valid, false);
    assert.equal(validateRelativePath('D:\\Projects\\code.py').valid, false);
    assert.equal(validateRelativePath('\0malicious.py').valid, false);
  });

  it('should normalize valid safe relative paths', () => {
    const res1 = validateRelativePath('src/utils/logger.py');
    assert.equal(res1.valid, true);
    assert.equal(res1.normalizedPath, 'src/utils/logger.py');

    const res2 = validateRelativePath('./src/routes/../routes/app.py');
    // If normalized within bounds:
    const res3 = validateRelativePath('tests/test_login.py');
    assert.equal(res3.valid, true);
    assert.equal(res3.normalizedPath, 'tests/test_login.py');
  });

  it('should filter out generated directories and binary artifacts', () => {
    assert.equal(shouldIgnoreFile('.git/config').ignore, true);
    assert.equal(shouldIgnoreFile('node_modules/express/index.js').ignore, true);
    assert.equal(shouldIgnoreFile('__pycache__/module.cpython-310.pyc').ignore, true);
    assert.equal(shouldIgnoreFile('build/output.exe').ignore, true);
    assert.equal(shouldIgnoreFile('assets/logo.png').ignore, true);
    assert.equal(shouldIgnoreFile('data/archive.zip').ignore, true);

    // Legitimate source files must NOT be ignored
    assert.equal(shouldIgnoreFile('src/auth.py').ignore, false);
    assert.equal(shouldIgnoreFile('tests/test_database.py').ignore, false);
    assert.equal(shouldIgnoreFile('src/components/Graph.tsx').ignore, false);
  });

  it('should categorize files accurately', () => {
    assert.equal(categorizeFile('tests/test_user.py'), 'test');
    assert.equal(categorizeFile('src/auth.test.ts'), 'test');
    assert.equal(categorizeFile('src/main.py'), 'source');
    assert.equal(categorizeFile('src/server.ts'), 'source');
    assert.equal(categorizeFile('config.json'), 'config');
    assert.equal(categorizeFile('README.md'), 'doc');
  });
});
