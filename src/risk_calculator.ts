/**
 * CodeGuard Deterministic SCM Risk Quantification Engine
 *
 * Mathematical Formula:
 *   Risk Score = (Dependents × DEPENDENT_WEIGHT)
 *              + (Past Defect Files × FAILURE_WEIGHT)
 *              + (Lines Changed ÷ LINES_CHANGE_DIVISOR)
 */

export const SCM_RISK_CONSTANTS = {
  DEPENDENT_WEIGHT: 2.0,
  FAILURE_WEIGHT: 3.0,
  LINES_CHANGE_DIVISOR: 20.0,
  HIGH_RISK_THRESHOLD: 10.0,
  MEDIUM_RISK_THRESHOLD: 5.0
} as const;

export interface RiskCalculationInput {
  changedFiles: Array<{ filepath: string; lines_added?: number; lines_deleted?: number; blame_author?: string }>;
  affectedFiles: Array<{ filepath: string; depth?: number; reason?: string }>;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  historicalFailingFiles: string[];
}

export interface HighRiskModule {
  filepath: string;
  depth: number;
  scoreContribution: number;
  reason: string;
  suggested_reviewer?: string;
}

export interface RiskAnalysisOutput {
  total_score: number;
  risk_level: 'High' | 'Medium' | 'Low';
  badge_class: 'risk-high' | 'risk-med' | 'risk-low';
  risk_color: '#ef4444' | '#f59e0b' | '#10b981';
  direct_dependents_count: number;
  transitive_impact_count: number;
  dependents_score: number;
  failing_files: string[];
  past_failures_score: number;
  lines_added: number;
  lines_deleted: number;
  total_lines_changed: number;
  lines_score: number;
  highest_risk_modules: HighRiskModule[];
  reviewer_suggestions: Array<{ file: string; suggested_reviewer: string; reason: string }>;
  formula_summary: string;
  viva_explanation: string;
}

export function calculateDeterministicRisk(input: RiskCalculationInput): RiskAnalysisOutput {
  const directDependents = input.affectedFiles.filter((af) => (af.depth || 1) === 1);
  const transitiveDependents = input.affectedFiles.filter((af) => (af.depth || 1) > 1);

  const directCount = directDependents.length;
  const transitiveCount = transitiveDependents.length;
  const totalDependentsCount = input.affectedFiles.length;

  const dependentsScore =
    Math.round(totalDependentsCount * SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT * 10) / 10;

  // Identify past defect files relevant to changed or affected files
  const relevantFailingFiles: string[] = [];
  const candidateFiles = [
    ...input.changedFiles.map((cf) => cf.filepath),
    ...input.affectedFiles.map((af) => af.filepath)
  ];

  const historicalSet = new Set(input.historicalFailingFiles.map((f) => f.toLowerCase()));

  for (const cf of candidateFiles) {
    const cfNorm = cf.toLowerCase();
    const base = cfNorm.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    let matched = false;
    for (const hf of historicalSet) {
      if (hf.includes(cfNorm) || cfNorm.includes(hf) || hf.includes(base)) {
        if (!relevantFailingFiles.includes(cf)) {
          relevantFailingFiles.push(cf);
          matched = true;
          break;
        }
      }
    }
  }

  const pastFailuresScore =
    Math.round(relevantFailingFiles.length * SCM_RISK_CONSTANTS.FAILURE_WEIGHT * 10) / 10;

  const totalLines = (input.totalLinesAdded || 0) + (input.totalLinesDeleted || 0);
  const linesScore =
    Math.round((totalLines / SCM_RISK_CONSTANTS.LINES_CHANGE_DIVISOR) * 10) / 10;

  const totalScore =
    Math.round((dependentsScore + pastFailuresScore + linesScore) * 10) / 10;

  let riskLevel: 'High' | 'Medium' | 'Low' = 'Low';
  let badgeClass: 'risk-high' | 'risk-med' | 'risk-low' = 'risk-low';
  let riskColor: '#ef4444' | '#f59e0b' | '#10b981' = '#10b981';

  if (totalScore >= SCM_RISK_CONSTANTS.HIGH_RISK_THRESHOLD) {
    riskLevel = 'High';
    badgeClass = 'risk-high';
    riskColor = '#ef4444';
  } else if (totalScore >= SCM_RISK_CONSTANTS.MEDIUM_RISK_THRESHOLD) {
    riskLevel = 'Medium';
    badgeClass = 'risk-med';
    riskColor = '#f59e0b';
  }

  // Reviewer suggestions from authors of modified files
  const reviewerSuggestions: Array<{ file: string; suggested_reviewer: string; reason: string }> = [];
  const seenReviewers = new Set<string>();

  input.changedFiles.forEach((cf) => {
    const author = cf.blame_author || 'Primary Baseline Author';
    if (!seenReviewers.has(author)) {
      seenReviewers.add(author);
      reviewerSuggestions.push({
        file: cf.filepath,
        suggested_reviewer: author,
        reason: 'Most recent author associated with modified baseline changes'
      });
    }
  });

  // Calculate highest risk modules
  const highestRiskModules: HighRiskModule[] = input.affectedFiles.map((af) => {
    const isDirect = (af.depth || 1) === 1;
    const isFailing = relevantFailingFiles.includes(af.filepath);
    const contribution =
      (isDirect ? SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT : SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT * 0.5) +
      (isFailing ? SCM_RISK_CONSTANTS.FAILURE_WEIGHT : 0);

    return {
      filepath: af.filepath,
      depth: af.depth || 1,
      scoreContribution: Math.round(contribution * 10) / 10,
      reason: isFailing
        ? `Direct dependent with known historical defect records`
        : isDirect
        ? `Direct downstream consumer of modified source`
        : `Transitive dependent at blast depth ${af.depth}`
    };
  });

  highestRiskModules.sort((a, b) => b.scoreContribution - a.scoreContribution || a.depth - b.depth);

  const formulaSummary = `(${totalDependentsCount} dependents × ${SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT}) + (${relevantFailingFiles.length} past defect files × ${SCM_RISK_CONSTANTS.FAILURE_WEIGHT}) + (${totalLines} lines ÷ ${SCM_RISK_CONSTANTS.LINES_CHANGE_DIVISOR})`;

  const vivaExplanation =
    `CodeGuard uses a linear multi-factor weighted SCM model: ` +
    `1. Architectural Fan-out (${dependentsScore} pts from ${totalDependentsCount} dependent files, w=${SCM_RISK_CONSTANTS.DEPENDENT_WEIGHT}). ` +
    `2. Defect History (${pastFailuresScore} pts from ${relevantFailingFiles.length} files with prior test failures, w=${SCM_RISK_CONSTANTS.FAILURE_WEIGHT}). ` +
    `3. Code Churn (${linesScore} pts from ${totalLines} net changed lines, divisor=${SCM_RISK_CONSTANTS.LINES_CHANGE_DIVISOR}). ` +
    `Final deterministic score is ${totalScore} (${riskLevel} Risk).`;

  return {
    total_score: totalScore,
    risk_level: riskLevel,
    badge_class: badgeClass,
    risk_color: riskColor,
    direct_dependents_count: directCount,
    transitive_impact_count: transitiveCount,
    dependents_score: dependentsScore,
    failing_files: relevantFailingFiles,
    past_failures_score: pastFailuresScore,
    lines_added: input.totalLinesAdded,
    lines_deleted: input.totalLinesDeleted,
    total_lines_changed: totalLines,
    lines_score: linesScore,
    highest_risk_modules: highestRiskModules.slice(0, 10),
    reviewer_suggestions: reviewerSuggestions,
    formula_summary: formulaSummary,
    viva_explanation: vivaExplanation
  };
}
