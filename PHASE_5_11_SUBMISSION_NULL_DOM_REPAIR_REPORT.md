# PHASE 5.11 — MOCK TEST SUBMISSION NULL DOM REFERENCE REPAIR & ACCEPTANCE REPORT

**Project:** VidyarthiAstra / PYQS Hub  
**Date:** November 17, 2026  
**Environment:** Local Development Environment (Node.js v24.16.0, Chromium Headless / Real Google Chrome Engine)  
**Investigation Scope:** Mock-Test Submission Lifecycle, Dynamic DOM Resolution, Skeleton Lifecycle Restoration, Concurrency Protection, and Multi-Exam Scorecard Integrity  
**Status:** **100% PASS — RESOLVED & ACCEPTED**  

---

## 1. Executive Summary & Defect Statement

### 1.1 Confirmed Defect
When candidates submitted any mock test session (NEET UG, GATE, SSC CGL), the browser console caught an uncaught exception, triggering a blocking alert modal:
```
Error during test submission: Cannot set properties of null (setting 'textContent')
```
This error occurred across all examinations and resulted in a disrupted submission workflow, preventing candidates from viewing their scorecards, accuracy metrics, subject breakdowns, and review mode.

### 1.2 Remediation Summary
The forensic root-cause analysis identified an asynchronous lifecycle conflict between the universal skeleton loading system (`SkeletonManager`) and result view rendering (`renderResults`):
1. **Destructive Template Overwrite:** In `executeSubmission()`, when API evaluation latency exceeded the 200 ms debounce threshold, `SkeletonManager.mount(dom.resultView, ...)` mounted an accessible skeleton placeholder by overwriting `dom.resultView.innerHTML`.
2. **Missing Template Restoration:** When `resultsSkeleton.dismiss()` executed upon receipt of the evaluation payload from `/submit`, it removed loading indicators but did **not** restore the original `<section id="resultView">` DOM nodes (`#resTotalScore`, `#resMaxScore`, `#resPercentage`, etc.).
3. **Null Dereference:** `renderResults(data.result)` immediately attempted to assign `dom.resTotalScore.textContent = result.totalScore`. Because `resTotalScore` was no longer in the DOM tree, `document.getElementById("resTotalScore")` returned `null`, throwing `TypeError: Cannot set properties of null (setting 'textContent')`.
4. **Complete Remediation:**
   - **Template Snapshots:** Snapshotted `resultViewInitialHTML` and `reviewViewInitialHTML` at module load before any mutation.
   - **Template Restoration & Control Rebinding:** Implemented `restoreResultViewTemplate()` and `bindResultControls()`, which safely re-injects the original markup and reattaches event listeners to `#btnReviewExam` and `#btnReturnCatalog`.
   - **Comprehensive Dynamic DOM Resolver:** Extended `getTestDOM()` to dynamically query all submission, confirmation, scorecard, and review elements from the live DOM.
   - **Strict Pre-Render DOM Validation:** Added fail-safe validation in `renderResults` that verifies all 8 required scorecard elements exist, logging diagnostic metadata (`RESULT_DOM_VALIDATION_FAILED`) rather than failing on an unhandled null dereference.
   - **Concurrency Guard:** Installed an `isSubmitting` boolean mutex in `executeSubmission()`, blocking duplicate submissions from rapid double-clicks.
   - **Zero-Loss Session Rollback:** Integrated automatic error recovery in the submission catch block: if the network or evaluation API fails, the candidate's answers in memory are strictly preserved, `testView` template is restored, the active question is re-rendered with choices intact, and the countdown timer is resumed.

All 14 unit and integration tests and all 161 multi-phase regression tests pass with zero failures. Full end-to-end browser acceptance in Google Chrome confirms complete operational integrity across NEET UG, GATE CS, and SSC CGL.

---

## 2. Root Cause Forensic Analysis

```mermaid
sequenceDiagram
    autonumber
    actor Candidate as Student Candidate
    participant Modal as #submitModal
    participant Client as mock-test.js
    participant Skel as SkeletonManager
    participant API as /api/mock-tests/.../submit
    participant Engine as UniversalScoringEngine

    Candidate->>Modal: Clicks "Yes, Submit Now" (#modalBtnConfirm)
    Modal->>Client: confirmSubmit() -> executeSubmission()
    Client->>Skel: mount(resultView, { delay: 200 })
    Note over Skel: 200ms debounce fires:<br/>resultView.innerHTML = `<div class="skeleton">...</div>`<br/>(resTotalScore, resMaxScore WIPED from DOM)
    Client->>API: POST /submit { answers }
    API->>Engine: evaluateAttempt({ questions, answerKeys, answers })
    Engine-->>API: Authoritative evaluation (UIR v3.0)
    API-->>Client: 200 OK { result: { totalScore: 8, ... } }
    
    rect rgb(255, 235, 235)
    Note over Client: BEFORE FIX:<br/>resultsSkeleton.dismiss() called WITHOUT restoring template.<br/>renderResults() calls dom.resTotalScore.textContent = 8<br/>Throws TypeError: Cannot set properties of null (setting 'textContent')
    end

    rect rgb(235, 255, 235)
    Note over Client: AFTER FIX (PHASE 5.11):<br/>resultsSkeleton.dismiss(() => {<br/>  restoreResultViewTemplate();<br/>  renderResults(data.result);<br/>})<br/>Pristine DOM restored; scorecard renders seamlessly!
    end
```

### 2.1 The DOM Destruction Mechanism
1. **Module Evaluation:** `www/mock-test.html` loads with static markup for `#resultView`, containing `<span id="resTotalScore">`, `<span id="resMaxScore">`, `<span id="resAccuracy">`, etc.
2. **Submission Initiation:** Candidate triggers submission. Because submission involves an asynchronous network flight and backend evaluation, `SkeletonManager.mount` is scheduled with a 200ms debounce.
3. **The InnerHTML Replacement:** When network round-trip time exceeded 200ms (standard for multi-question evaluation), `SkeletonManager.mount` wiped `#resultView`'s child elements:
   ```javascript
   container.innerHTML = templateFn(); // Overwrites all scorecard markup!
   ```
4. **The Missing Reversal:** In Phase 5.10, template restoration was added for `testView` (`restoreTestViewTemplate()`), but `resultView` and `reviewView` were omitted.
5. **The Fatal Dereference:** When the submission response arrived:
   ```javascript
   // Previous code:
   if (resultsSkeleton) {
       resultsSkeleton.dismiss();
   }
   renderResults(data.result); // document.getElementById('resTotalScore') is NULL!
   ```
   Calling `.textContent = ...` on `null` immediately crashed JavaScript execution.

---

## 3. Architecture & Implementation Remediation

### 3.1 Pristine Template Snapshots
At module evaluation time in [`www/js/mock-test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/www/js/mock-test.js), the virgin HTML structure of `resultView` and `reviewView` is preserved prior to any user interactions or skeleton mounts:
```javascript
const testViewInitialHTML = document.getElementById("testView")?.innerHTML || "";
const resultViewInitialHTML = document.getElementById("resultView")?.innerHTML || "";
const reviewViewInitialHTML = document.getElementById("reviewView")?.innerHTML || "";
```

### 3.2 Dynamic DOM Resolution via `getTestDOM()`
All submission, result, and review components are dynamically resolved to prevent caching detached DOM nodes:
```javascript
function getTestDOM() {
    return {
        // ... (Test View elements)
        btnTopSubmit: document.getElementById("btnTopSubmit"),
        submitModal: document.getElementById("submitModal"),
        modalBtnConfirm: document.getElementById("modalBtnConfirm"),
        modalBtnCancel: document.getElementById("modalBtnCancel"),
        modalAnsweredCount: document.getElementById("modalAnsweredCount"),
        modalUnansweredCount: document.getElementById("modalUnansweredCount"),
        modalReviewCount: document.getElementById("modalReviewCount"),
        // Result View elements
        resultView: document.getElementById("resultView"),
        resTotalScore: document.getElementById("resTotalScore"),
        resMaxScore: document.getElementById("resMaxScore"),
        resPercentage: document.getElementById("resPercentage"),
        resAccuracy: document.getElementById("resAccuracy"),
        resTotalQuestions: document.getElementById("resTotalQuestions"),
        resCorrect: document.getElementById("resCorrect"),
        resIncorrect: document.getElementById("resIncorrect"),
        resUnanswered: document.getElementById("resUnanswered"),
        resDroppedBox: document.getElementById("resDroppedBox"),
        resDropped: document.getElementById("resDropped"),
        resTimeTaken: document.getElementById("resTimeTaken"),
        resPendingNotice: document.getElementById("resPendingNotice"),
        resLegacyNotice: document.getElementById("resLegacyNotice"),
        subjectCardsGrid: document.getElementById("subjectCardsGrid"),
        sectionAnalysisSection: document.getElementById("sectionAnalysisSection"),
        sectionCardsGrid: document.getElementById("sectionCardsGrid"),
        subjectPerformanceChart: document.getElementById("subjectPerformanceChart"),
        btnReviewExam: document.getElementById("btnReviewExam"),
        btnReturnCatalog: document.getElementById("btnReturnCatalog"),
        // Review View elements
        reviewView: document.getElementById("reviewView"),
        // ...
    };
}
```

### 3.3 Template Restoration & Event Rebinding
Whenever `resultView` or `reviewView` is opened after skeleton dismissal, the template is restored and controls are rebound to fresh DOM nodes:
```javascript
function restoreResultViewTemplate() {
    const rv = document.getElementById("resultView");
    if (rv && resultViewInitialHTML) {
        rv.innerHTML = resultViewInitialHTML;
        bindResultControls();
    }
}

function bindResultControls() {
    const dom = getTestDOM();
    if (dom.btnReviewExam) {
        dom.btnReviewExam.onclick = () => {
            if (activeAttempt && activeAttempt.attemptId) {
                openReviewExam(activeAttempt.attemptId);
            }
        };
    }
    if (dom.btnReturnCatalog) {
        dom.btnReturnCatalog.onclick = exitToCatalog;
    }
}
```

### 3.4 Concurrency Guard (`isSubmitting`)
To prevent duplicate network payloads and race conditions caused by rapid double-clicking on `#modalBtnConfirm`:
```javascript
let isSubmitting = false;

async function executeSubmission() {
    if (isSubmitting) {
        logDiag("CONCURRENT_SUBMIT_BLOCKED", { attemptId: activeAttempt?.attemptId });
        return;
    }
    isSubmitting = true;
    // ...
    try {
        // flush autosave, dispatch POST /submit
    } finally {
        isSubmitting = false;
    }
}
```

### 3.5 Pre-Render DOM Validation
Before attempting to write to `textContent`, `renderResults` validates that all required scorecard elements are present in the DOM:
```javascript
const requiredKeys = [
    "resTotalScore", "resMaxScore", "resPercentage", "resAccuracy",
    "resTotalQuestions", "resCorrect", "resIncorrect", "resUnanswered"
];
const missingKeys = requiredKeys.filter(k => !dom[k]);
if (missingKeys.length > 0) {
    const missingIds = missingKeys.map(k => `#${k}`).join(", ");
    logDiag("RESULT_DOM_VALIDATION_FAILED", { missingIds });
    throw new Error(`Cannot render test results: missing required DOM elements (${missingIds}).`);
}
```

### 3.6 Zero-Loss Error Rollback
If the network disconnects or the submission API returns an error:
```javascript
    } catch (err) {
        logDiag("SUBMISSION_ERROR", { message: err.message });
        resultsSkeleton?.cancel();

        const curDom = getTestDOM();
        if (curDom.resultView) curDom.resultView.style.display = "none";
        if (curDom.testView) {
            restoreTestViewTemplate();
            curDom.testView.style.display = "block";
            renderQuestion(currentIndex);
            if (activeAttempt?.deadlineAt) {
                startTimer(activeAttempt.deadlineAt);
            }
        }
        alert(`Error during test submission: ${err.message}`);
    } finally {
        isSubmitting = false;
    }
```
The candidate's in-memory answers, timer state, and question index remain 100% intact, allowing immediate retry without losing progress.

---

## 4. Scoring Authority & Mathematical Integrity

1. **UniversalScoringEngine Invariance:**
   - UniversalScoringEngine remains the sole, authoritative scoring engine.
   - Zero frontend calculations: the client only renders the exact score, accuracy, percentages, and breakdowns supplied by the server.
   - All evaluation profiles (NEET UG: 720 marks, GATE CS: 100 marks, SSC CGL: 200 marks) are preserved without modification.
2. **Negative Marking & Answer Keys:**
   - Zero modifications to negative marking formulas, answer key reconciliation tables, or official test schemas.
   - UIR v3.0 compliance is strictly preserved.

---

## 5. Google Chrome Acceptance Verification

The acceptance test script [`scripts/run_phase_5_11_browser_acceptance.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/scripts/run_phase_5_11_browser_acceptance.js) executed in headless Google Chrome (`playwright-core`) against the live application runtime.

### 5.1 Acceptance Test Results Matrix

| Stage | Test Scenario | Verified Assertions | Status |
|:---|:---|:---|:---:|
| **Stage 1** | NEET UG 2024 (180 Qs) | • Q1 Physics and Q91 Biology answered<br>• Submit modal shows Answered: 2, Unanswered: 178<br>• Latency skeleton triggers at 200ms<br>• Template restored, zero null errors<br>• Scorecard: Total Score 8, out of 720, 100% Accuracy, 1.11% Score<br>• Transition to Review Mode via `#btnReviewExam` works cleanly<br>• Back to Analysis via `#btnBackToAnalysis` returns to scorecard | **PASS** |
| **Stage 2** | GATE CS 2026 (MCQ + NAT) | • Q1 MCQ answered (+1 mark)<br>• Q2 NAT answered with numerical input `512` (+2 marks)<br>• Scorecard renders: Total Score 3, out of 100, Accuracy 100%<br>• Section breakdown (GA: 1, Core CS: 2) | **PASS** |
| **Stage 3** | SSC CGL 2024 (4 Sections) | • Navigation across General Intelligence & General Awareness<br>• Scorecard renders: out of 200<br>• Section breakdown populated | **PASS** |
| **Stage 4** | Rapid Double-Click Concurrency | • Rapid double/triple click on `#modalBtnConfirm`<br>• Exact single flight dispatched (`submissionApiRequests.length === 1`)<br>• `CONCURRENT_SUBMIT_BLOCKED` captured twice | **PASS** |
| **Stage 5** | API Failure Rollback & Recovery | • Server returns HTTP 500 error<br>• View safely reverts to `testView`<br>• Selected choice ("2") strictly preserved in memory and on screen<br>• Timer resumes seamlessly | **PASS** |

---

## 6. Acceptance Visual Proofs & Evidence Carousel

The following visual artifacts were captured during the real Google Chrome acceptance run and stored in both the repository root [`phase_5_11_acceptance_screenshots/`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_11_acceptance_screenshots/) and the brain artifact store:

````carousel
![NEET UG Submission Modal](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/01_neet_ug_submission_confirmation.png)
<!-- slide -->
![NEET UG Result Scorecard](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/02_neet_ug_result_scorecard.png)
<!-- slide -->
![NEET UG Exam Review Mode](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/03_neet_ug_exam_review_mode.png)
<!-- slide -->
![GATE CS Scorecard](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/04_gate_cs_result_scorecard.png)
<!-- slide -->
![SSC CGL Scorecard](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/05_ssc_cgl_result_scorecard.png)
<!-- slide -->
![Concurrency Guard](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/06_concurrency_guard_single_flight.png)
<!-- slide -->
![Failure Rollback](/C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/07_submission_failure_rollback.png)
````

1. [01_neet_ug_submission_confirmation.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/01_neet_ug_submission_confirmation.png) — Displays the submission confirmation modal showing Answered: 2, Unanswered: 178, and confirmation buttons.
2. [02_neet_ug_result_scorecard.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/02_neet_ug_result_scorecard.png) — Scorecard rendering with ZERO null DOM errors: Total Score 8, `out of 720`, Accuracy 100%, and Subject Score Cards.
3. [03_neet_ug_exam_review_mode.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/03_neet_ug_exam_review_mode.png) — Exam Review mode opened via `#btnReviewExam`, displaying Question 1 review, marks, and summary pills.
4. [04_gate_cs_result_scorecard.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/04_gate_cs_result_scorecard.png) — Authoritative scorecard for GATE CS (Total Score 3, `out of 100`, MCQ + NAT evaluation).
5. [05_ssc_cgl_result_scorecard.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/05_ssc_cgl_result_scorecard.png) — Authoritative scorecard for SSC CGL (`out of 200`) across all 4 section tiers.
6. [06_concurrency_guard_single_flight.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/06_concurrency_guard_single_flight.png) — Single flight guaranteed under rapid double clicks with `CONCURRENT_SUBMIT_BLOCKED` logging.
7. [07_submission_failure_rollback.png](file:///C:/Users/RUPENDRA/.gemini/antigravity/brain/7992c996-d93f-4944-8d23-3e2c2824f9ca/phase_5_11_acceptance_screenshots/07_submission_failure_rollback.png) — Safe rollback to `testView` upon HTTP 500 failure; candidate answers and timer fully preserved.

---

## 7. Full Regression Test Matrix

All test suites covering Phase 5.5 through Phase 5.11 were executed via Node.js native test runner:

```powershell
node --test tests/phase-5-11-mock-test-submission-dom.test.js tests/phase-5-10-mock-test-rendering.test.js tests/firestore-quota-recovery.test.js tests/student-skeleton-system.test.js tests/phase-5-9-1-independent-verification.test.js tests/phase-5-6-1-scoring-acceptance.test.js tests/phase-5-6-2-negative-marking-audit.test.js tests/universal-scoring-engine.test.js tests/phase-5-5-numerical-input.test.js tests/phase-5-5-question-boundary.test.js
```

### 7.1 Regression Suite Results Breakdown

| Test Suite File | Tests | Pass | Fail | Execution Time | Scope / Coverage |
|:---|:---:|:---:|:---:|:---:|:---|
| [`tests/phase-5-11-mock-test-submission-dom.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-11-mock-test-submission-dom.test.js) | 14 | 14 | 0 | 65 ms | Dynamic DOM resolution, template restoration, concurrency guard, pre-render validation |
| [`tests/phase-5-10-mock-test-rendering.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-10-mock-test-rendering.test.js) | 13 | 13 | 0 | 7 ms | Question normalization, palette population, DOM detachment immunity, diagnostics |
| [`tests/firestore-quota-recovery.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/firestore-quota-recovery.test.js) | 13 | 13 | 0 | 1305 ms | Quota 429 backoff, single-flight coalescing, TTL cache, role resolution |
| [`tests/student-skeleton-system.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/student-skeleton-system.test.js) | 21 | 21 | 0 | 615 ms | 200ms debounce, 13 student routes, accessibility, deferred countdown |
| [`tests/phase-5-9-1-independent-verification.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-9-1-independent-verification.test.js) | 13 | 13 | 0 | 15 ms | Read measurement, independent Firestore audit, recovery cards |
| [`tests/phase-5-6-1-scoring-acceptance.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-6-1-scoring-acceptance.test.js) | 18 | 18 | 0 | 25 ms | Score rational invariants, GATE max marks independence |
| [`tests/phase-5-6-2-negative-marking-audit.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-6-2-negative-marking-audit.test.js) | 16 | 16 | 0 | 20 ms | Negative marking precedence, fractional penalties |
| [`tests/universal-scoring-engine.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/universal-scoring-engine.test.js) | 26 | 26 | 0 | 48 ms | Exact BigInt rational arithmetic, 10 exam archetypes, dropped question policies |
| [`tests/phase-5-5-numerical-input.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-5-numerical-input.test.js) | 15 | 15 | 0 | 12 ms | NAT input validation, float/integer bounds, auto-formatting |
| [`tests/phase-5-5-question-boundary.test.js`](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-5-question-boundary.test.js) | 12 | 12 | 0 | 9 ms | Question index boundaries, palette sync, section edge transitions |
| **TOTAL** | **161** | **161** | **0** | **~1845 ms** | **100% PASS across all 10 test suites** |

---

## 8. Final Verdict & Sign-Off

The confirmed defect `Cannot set properties of null (setting 'textContent')` encountered during test submission has been completely eradicated. 

1. **Root cause resolved:** Destructive skeleton innerHTML replacement eliminated through module-level template snapshots and automatic DOM template restoration upon skeleton dismissal.
2. **Dynamic resolution:** All 26 submission, modal, result, and review elements are dynamically resolved via `getTestDOM()` on live DOM nodes.
3. **Concurrency & Resilience:** Single-flight submission guaranteed via `isSubmitting` mutex; candidate responses 100% preserved during network/API failures.
4. **Scoring integrity:** UniversalScoringEngine and UIR v3.0 remain the sole scoring authority with zero frontend calculations and zero modification to marking schemes.
5. **Acceptance verified:** Full browser acceptance in real Google Chrome across NEET UG, GATE CS, and SSC CGL achieves 100% compliance with zero console errors.

**FINAL STATUS: PHASE 5.11 ACCEPTANCE PASSED AND COMPLETE.**
