import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDependencyGraph,
  calculateBlastRadius,
  calculateCombinedBlastRadius
} from '../src/dependency_analyzer.js';

describe('CodeGuard Source Dependency Analyzer', () => {
  it('should parse Python absolute and relative imports into genuine directed edges', () => {
    const files = [
      {
        relativePath: 'src/database.py',
        content: `
import os
import sys
class Database:
    pass
`
      },
      {
        relativePath: 'src/models.py',
        content: `
import database
from . import database as db
from database import Database
`
      },
      {
        relativePath: 'src/services/auth.py',
        content: `
from ..models import Database
import src.database
`
      },
      {
        relativePath: 'tests/test_auth.py',
        content: `
import unittest
from src.services.auth import login
`
      }
    ];

    const graph = buildDependencyGraph(files);

    // Nodes should contain all 4 files
    assert.equal(graph.nodes.length, 4);

    // External built-ins (os, sys, unittest) should NOT become local graph edges
    const externalEdges = graph.edges.filter(
      (e) => e.target_file.includes('os') || e.target_file.includes('sys') || e.target_file.includes('unittest')
    );
    assert.equal(externalEdges.length, 0, 'No external libraries in local dependency edges');

    // Edge check: src/models.py imports src/database.py
    const modelsImportDb = graph.edges.some(
      (e) => e.source_file === 'src/models.py' && e.target_file === 'src/database.py'
    );
    assert.ok(modelsImportDb, 'models.py should have import edge to database.py');

    // Dependents check: who depends on database.py?
    const dbDependents = graph.dependentsMap['src/database.py'] || [];
    assert.ok(dbDependents.includes('src/models.py'), 'models.py is a dependent of database.py');
  });

  it('should parse TypeScript/JavaScript imports with extension and index resolution', () => {
    const files = [
      {
        relativePath: 'src/utils/logger.ts',
        content: `export function log(msg: string) {}`
      },
      {
        relativePath: 'src/services/api.ts',
        content: `
import { log } from '../utils/logger';
import express from 'express';
`
      },
      {
        relativePath: 'src/index.ts',
        content: `
const api = require('./services/api');
export * from './services/api';
`
      }
    ];

    const graph = buildDependencyGraph(files);

    assert.equal(graph.nodes.length, 3);

    // express should be filtered out
    const expressEdges = graph.edges.filter((e) => e.target_file === 'express');
    assert.equal(expressEdges.length, 0);

    // api.ts imports utils/logger.ts
    const apiImportsLogger = graph.edges.some(
      (e) => e.source_file === 'src/services/api.ts' && e.target_file === 'src/utils/logger.ts'
    );
    assert.ok(apiImportsLogger, 'api.ts should import logger.ts');

    // index.ts imports services/api.ts
    const indexImportsApi = graph.edges.some(
      (e) => e.source_file === 'src/index.ts' && e.target_file === 'src/services/api.ts'
    );
    assert.ok(indexImportsApi, 'index.ts should import api.ts');
  });

  it('should calculate direct and transitive blast radius without infinite loop on cycles', () => {
    // Cyclic dependency: A -> B -> C -> A
    const files = [
      {
        relativePath: 'cycle/a.py',
        content: `import cycle.b`
      },
      {
        relativePath: 'cycle/b.py',
        content: `import cycle.c`
      },
      {
        relativePath: 'cycle/c.py',
        content: `import cycle.a`
      },
      {
        relativePath: 'cycle/downstream.py',
        content: `import cycle.c`
      }
    ];

    const graph = buildDependencyGraph(files);
    assert.equal(graph.nodes.length, 4);

    // Calculate blast radius when cycle/a.py changes:
    // Who imports a.py? cycle/c.py imports a.py (direct dependent of a.py is c.py)
    // Who imports c.py? cycle/b.py and cycle/downstream.py import c.py
    // Who imports b.py? cycle/a.py imports b.py (cycle closes back to a)
    const blast = calculateBlastRadius('cycle/a.py', graph);

    assert.ok(blast.hasCycle, 'Cycle should be detected');
    assert.ok(blast.directDependents.includes('cycle/c.py'), 'c.py imports a.py directly');
    assert.ok(blast.transitiveBlastRadius.includes('cycle/b.py'), 'b.py in transitive blast radius');
    assert.ok(blast.transitiveBlastRadius.includes('cycle/downstream.py'), 'downstream.py in blast radius');
    // Ensure all impacted files list has no duplicates
    assert.equal(new Set(blast.allImpactedFiles).size, blast.allImpactedFiles.length);
  });

  it('should calculate combined blast radius for multiple changed files', () => {
    const files = [
      {
        relativePath: 'db.py',
        content: ``
      },
      {
        relativePath: 'cache.py',
        content: ``
      },
      {
        relativePath: 'auth.py',
        content: `import db\nimport cache`
      },
      {
        relativePath: 'routes.py',
        content: `import auth`
      }
    ];

    const graph = buildDependencyGraph(files);
    const combined = calculateCombinedBlastRadius(['db.py', 'cache.py'], graph);

    assert.ok(combined.impactedFiles.includes('auth.py'));
    assert.ok(combined.impactedFiles.includes('routes.py'));
    assert.equal(combined.maxDepth, 2);
  });
});
