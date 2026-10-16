import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDeterministicRisk, SCM_RISK_CONSTANTS } from '../src/risk_calculator.js';

describe('CodeGuard Deterministic Risk Calculator', () => {
  it('should enforce exact formula constants', () => {
    assert.equal(SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT, 2.0);
    assert.equal(SCM_RISK_CONSTANTS.FAILURE_WEIGHT, 3.0);
    assert.equal(SCM_RISK_CONSTANTS.LINES_CHANGE_DIVISOR, 20.0);
    assert.equal(SCM_RISK_CONSTANTS.HIGH_RISK_THRESHOLD, 10.0);
    assert.equal(SCM_RISK_CONSTANTS.MEDIUM_RISK_THRESHOLD, 5.0);
  });

  it('should calculate correct score for Low risk baseline (small changes, no dependents, no past defects)', () => {
    const result = calculateDeterministicRisk({
      changedFiles: [{ filepath: 'src/utils/logger.py', lines_added: 4, lines_deleted: 1 }],
      affectedFiles: [],
      totalLinesAdded: 4,
      totalLinesDeleted: 1,
      historicalFailingFiles: []
    });

    // 0 dependents * 2.0 = 0
    // 0 past defect files * 3.0 = 0
    // 5 lines / 20.0 = 0.25 -> 0.3
    assert.equal(result.dependents_score, 0);
    assert.equal(result.past_failures_score, 0);
    assert.equal(result.lines_score, 0.3);
    assert.equal(result.total_score, 0.3);
    assert.equal(result.risk_level, 'Low');
    assert.equal(result.badge_class, 'risk-low');
    assert.equal(result.risk_color, '#10b981');
  });

  it('should calculate correct score for Medium risk baseline (5.0 <= score < 10.0)', () => {
    const result = calculateDeterministicRisk({
      changedFiles: [
        { filepath: 'src/auth.py', lines_added: 15, lines_deleted: 5, blame_author: 'Jane Doe' }
      ],
      affectedFiles: [
        { filepath: 'src/routes.py', depth: 1, reason: 'Direct import' },
        { filepath: 'src/app.py', depth: 2, reason: 'Transitive import' }
      ],
      totalLinesAdded: 15,
      totalLinesDeleted: 5,
      historicalFailingFiles: []
    });

    // 2 dependents * 2.0 = 4.0
    // 0 failures = 0
    // 20 lines / 20.0 = 1.0
    // total = 4.0 + 0 + 1.0 = 5.0 -> Medium
    assert.equal(result.dependents_score, 4.0);
    assert.equal(result.lines_score, 1.0);
    assert.equal(result.total_score, 5.0);
    assert.equal(result.risk_level, 'Medium');
    assert.equal(result.badge_class, 'risk-med');
    assert.equal(result.risk_color, '#f59e0b');
  });

  it('should calculate correct score for High risk baseline (score >= 10.0)', () => {
    const result = calculateDeterministicRisk({
      changedFiles: [
        { filepath: 'database.py', lines_added: 40, lines_deleted: 10, blame_author: 'Alex Developer' }
      ],
      affectedFiles: [
        { filepath: 'login.py', depth: 1, reason: 'Direct import' },
        { filepath: 'payment.py', depth: 1, reason: 'Direct import' },
        { filepath: 'profile.py', depth: 1, reason: 'Direct import' },
        { filepath: 'test_database.py', depth: 1, reason: 'Test import' }
      ],
      totalLinesAdded: 40,
      totalLinesDeleted: 10,
      historicalFailingFiles: ['database.py', 'test_database.py']
    });

    // 4 dependents * 2.0 = 8.0
    // 2 historical defect files ('database.py', 'test_database.py') * 3.0 = 6.0
    // 50 lines / 20.0 = 2.5
    // total = 8.0 + 6.0 + 2.5 = 16.5 -> High
    assert.equal(result.dependents_score, 8.0);
    assert.equal(result.past_failures_score, 6.0);
    assert.equal(result.lines_score, 2.5);
    assert.equal(result.total_score, 16.5);
    assert.equal(result.risk_level, 'High');
    assert.equal(result.badge_class, 'risk-high');
    assert.equal(result.risk_color, '#ef4444');
    assert.equal(result.failing_files.length, 2);
    assert.equal(result.highest_risk_modules.length, 4);
    assert.ok(result.viva_explanation.toLowerCase().includes('linear multi-factor weighted scm model'));
  });

  it('should handle zero lines changed and empty affected files safely without NaN', () => {
    const result = calculateDeterministicRisk({
      changedFiles: [],
      affectedFiles: [],
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      historicalFailingFiles: []
    });

    assert.equal(result.total_score, 0);
    assert.equal(result.risk_level, 'Low');
    assert.ok(!isNaN(result.total_score));
  });
});
