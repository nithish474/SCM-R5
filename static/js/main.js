/**
 * CodeGuard - Client-Side Interactive Engine
 * SCM Concept: User Interface for Configuration Audit, AST Impact, & RTS Testing Control
 */

// Global Toast Notification Utility
function showToast(title, message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    // SVG icon by type
    let iconSvg = '';
    if (type === 'success') {
        iconSvg = `<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
        iconSvg = `<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else if (type === 'warning') {
        iconSvg = `<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else {
        iconSvg = `<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
        ${iconSvg}
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" aria-label="Dismiss notification" onclick="dismissToast(this.closest('.toast'))">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
    `;

    container.appendChild(toast);

    // Auto dismiss after 4.5 seconds
    setTimeout(() => {
        dismissToast(toast);
    }, 4500);
}

function dismissToast(toastEl) {
    if (!toastEl || toastEl.classList.contains('toast-hiding')) return;
    toastEl.classList.add('toast-hiding');
    setTimeout(() => {
        if (toastEl.parentNode) {
            toastEl.parentNode.removeChild(toastEl);
        }
    }, 200);
}

// Mobile Nav Toggle
function toggleNavMenu() {
    const navLinks = document.getElementById('navLinksContainer');
    const toggleBtn = document.getElementById('navToggleBtn');
    if (!navLinks) return;
    const isOpen = navLinks.classList.toggle('nav-links-open');
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
}

// Quick Analyze Latest Commit Helper
async function quickAnalyzeLatest() {
    const navBtn = document.getElementById('navQuickAnalyzeBtn');
    const heroBtn = document.getElementById('heroAnalyzeLatestBtn');
    const originalNavHtml = navBtn ? navBtn.innerHTML : '';
    const originalHeroHtml = heroBtn ? heroBtn.innerHTML : '';

    if (navBtn) {
        navBtn.disabled = true;
        navBtn.innerHTML = `<span class="btn-spinner"></span> <span>Analyzing...</span>`;
    }
    if (heroBtn) {
        heroBtn.disabled = true;
        heroBtn.innerHTML = `<span class="btn-spinner"></span> <span>Analyzing Baseline...</span>`;
    }

    showToast('Analysis Initiated', 'Running AST dependency propagation & PyTest regression suite...', 'info');

    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commit_hash: 'HEAD', run_tests: true })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast('Analysis Complete', `Risk: ${data.risk_level} (${data.risk_score} pts) &bull; ${data.tests_run} tests evaluated`, 'success');
            setTimeout(() => {
                window.location.href = `/commit/${data.commit_hash}`;
            }, 800);
        } else {
            showToast('Analysis Error', data.message || 'Analysis could not be completed.', 'error');
            if (navBtn) {
                navBtn.disabled = false;
                navBtn.innerHTML = originalNavHtml;
            }
            if (heroBtn) {
                heroBtn.disabled = false;
                heroBtn.innerHTML = originalHeroHtml;
            }
        }
    } catch (err) {
        showToast('Connection Error', 'Failed to communicate with SCM server: ' + err.message, 'error');
        if (navBtn) {
            navBtn.disabled = false;
            navBtn.innerHTML = originalNavHtml;
        }
        if (heroBtn) {
            heroBtn.disabled = false;
            heroBtn.innerHTML = originalHeroHtml;
        }
    }
}

// Re-analyze specific commit on commit detail page
async function reanalyzeThisCommit() {
    const btn = document.getElementById('btn-reanalyze');
    const commitHashEl = document.querySelector('code');
    const hash = commitHashEl ? commitHashEl.textContent.trim() : 'HEAD';

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="btn-spinner"></span> Re-evaluating...`;
    }
    showToast('Re-analysis Running', `Re-evaluating AST dependencies for commit ${hash.substring(0, 7)}...`, 'info');

    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commit_hash: hash, run_tests: true })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast('Analysis Successful', `Updated risk score: ${data.risk_score} (${data.risk_level})`, 'success');
            setTimeout(() => {
                window.location.reload();
            }, 600);
        } else {
            showToast('Analysis Failed', data.message || 'Could not re-analyze commit.', 'error');
            if (btn) {
                btn.disabled = false;
                btn.innerText = 'Re-run Analysis';
            }
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Re-run Analysis';
        }
    }
}

// DOM Ready Handlers
document.addEventListener("DOMContentLoaded", () => {
    // 1. Quick Filter & Search for Commit Rows on Dashboard
    const searchInput = document.getElementById("commit-search");
    const riskFilterButtons = document.querySelectorAll(".risk-filter-btn");
    let activeRiskFilter = 'all';

    function applyCommitFilters() {
        const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
        const rows = document.querySelectorAll(".commit-row");
        let visibleCount = 0;

        rows.forEach((row) => {
            const text = row.innerText.toLowerCase();
            const rowRisk = (row.dataset.risk || '').toLowerCase();

            const matchesQuery = !query || text.includes(query);
            const matchesRisk = activeRiskFilter === 'all' || rowRisk === activeRiskFilter;

            if (matchesQuery && matchesRisk) {
                row.style.display = "";
                visibleCount++;
            } else {
                row.style.display = "none";
            }
        });

        // Show/hide empty state if all rows are filtered out
        const emptyState = document.getElementById("commitsEmptyFiltered");
        if (emptyState) {
            emptyState.style.display = (visibleCount === 0 && rows.length > 0) ? "" : "none";
        }
    }

    if (searchInput) {
        searchInput.addEventListener("input", applyCommitFilters);
    }

    if (riskFilterButtons.length > 0) {
        riskFilterButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                riskFilterButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeRiskFilter = btn.dataset.risk || 'all';
                applyCommitFilters();
            });
        });
    }

    // 2. Trigger Analysis Form on Dashboard
    const analyzeBtn = document.getElementById("btn-trigger-analyze");
    const commitSelect = document.getElementById("select-commit-hash");
    const customHashInput = document.getElementById("input-custom-hash");
    const analyzeStatus = document.getElementById("analyze-status");

    if (analyzeBtn) {
        analyzeBtn.addEventListener("click", async () => {
            const targetHash = (customHashInput && customHashInput.value.trim()) || 
                               (commitSelect && commitSelect.value) || 
                               "HEAD";

            if (!targetHash) {
                showToast('Warning', 'Please select or enter a valid commit hash.', 'warning');
                return;
            }

            if (analyzeStatus) {
                analyzeStatus.style.display = "inline-flex";
                analyzeStatus.innerHTML = `<span class="btn-spinner" style="border-color: rgba(37,99,235,0.3); border-top-color: #2563eb;"></span> <span style="color:#2563eb; font-weight: 500;">Analyzing ${targetHash.substring(0, 7)}... running SCM dependency & regression tests...</span>`;
            }
            analyzeBtn.disabled = true;
            showToast('Analysis Started', `Processing baseline ${targetHash.substring(0, 7)}...`, 'info');

            try {
                const res = await fetch("/api/analyze", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ commit_hash: targetHash, run_tests: true })
                });
                const data = await res.json();
                if (data.status === "success") {
                    showToast('Analysis Succeeded', `Risk: ${data.risk_level} (${data.risk_score} pts) &bull; ${data.tests_run} tests run`, 'success');
                    if (analyzeStatus) {
                        analyzeStatus.innerHTML = `<span style="color:#10b981; font-weight: 600;">✓ Completed! Risk: ${data.risk_level} (${data.risk_score}). Loading baseline detail...</span>`;
                    }
                    setTimeout(() => {
                        window.location.href = `/commit/${data.commit_hash}`;
                    }, 800);
                } else {
                    showToast('Analysis Failed', data.message || 'SCM analysis failed.', 'error');
                    if (analyzeStatus) {
                        analyzeStatus.innerHTML = `<span style="color:#ef4444; font-weight: 600;">Error: ${data.message}</span>`;
                    }
                    analyzeBtn.disabled = false;
                }
            } catch (err) {
                showToast('Network Error', err.message, 'error');
                if (analyzeStatus) {
                    analyzeStatus.innerHTML = `<span style="color:#ef4444; font-weight: 600;">Network error: ${err.message}</span>`;
                }
                analyzeBtn.disabled = false;
            }
        });
    }

    // 3. Batch Re-analyze All Commits
    const analyzeAllBtn = document.getElementById("btn-analyze-all");
    if (analyzeAllBtn) {
        analyzeAllBtn.addEventListener("click", async () => {
            if (!confirm("Re-analyze all repository commit history? This runs regression tests across all commits.")) return;
            analyzeAllBtn.disabled = true;
            const originalText = analyzeAllBtn.innerHTML;
            analyzeAllBtn.innerHTML = `<span class="btn-spinner"></span> <span>Analyzing All History...</span>`;
            showToast('Batch Analysis', 'Re-analyzing all commits and calculating regression impacts...', 'info');

            try {
                const res = await fetch("/api/analyze-all", { method: "POST" });
                const data = await res.json();
                if (data.status === "success") {
                    showToast('Batch Complete', 'All baselines analyzed successfully!', 'success');
                    setTimeout(() => {
                        window.location.reload();
                    }, 700);
                } else {
                    showToast('Analysis Error', data.message || 'Batch analysis encountered an issue.', 'error');
                    analyzeAllBtn.disabled = false;
                    analyzeAllBtn.innerHTML = originalText;
                }
            } catch (err) {
                showToast('Request Error', err.message, 'error');
                analyzeAllBtn.disabled = false;
                analyzeAllBtn.innerHTML = originalText;
            }
        });
    }
});

// Search & Filter for Regression Tests Page
function filterRtsRows(query) {
    const q = (query || '').toLowerCase().trim();
    const rows = document.querySelectorAll(".rts-row");
    let visible = 0;
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        if (!q || text.includes(q)) {
            row.style.display = "";
            visible++;
        } else {
            row.style.display = "none";
        }
    });

    const empty = document.getElementById("rtsEmptyFiltered");
    if (empty) {
        empty.style.display = (visible === 0 && rows.length > 0) ? "" : "none";
    }
}

// RTS Status Filter
function filterRtsStatus(status, btnEl) {
    document.querySelectorAll(".rts-status-btn").forEach(b => b.classList.remove("active"));
    if (btnEl) btnEl.classList.add("active");

    const rows = document.querySelectorAll(".rts-row");
    let visible = 0;
    rows.forEach(row => {
        const rowStatus = (row.dataset.status || '').toLowerCase();
        if (status === 'all' || rowStatus === status) {
            row.style.display = "";
            visible++;
        } else {
            row.style.display = "none";
        }
    });

    const empty = document.getElementById("rtsEmptyFiltered");
    if (empty) {
        empty.style.display = (visible === 0 && rows.length > 0) ? "" : "none";
    }
}
