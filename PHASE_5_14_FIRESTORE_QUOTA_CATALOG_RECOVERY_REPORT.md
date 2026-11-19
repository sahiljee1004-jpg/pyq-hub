# PHASE 5.14 — CRITICAL FIRESTORE QUOTA, AUTHENTICATION AND MOCK-TEST LOADING RECOVERY REPORT

**Project:** VidyarthiAstra / PYQS Hub  
**Date:** November 18, 2026  
**Environment:** Local Development (`C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`)  
**Status:** **100% Resolved & Verified (16/16 Automated Tests Passed, 90/90 Phase 5 Regression Passed, 6/6 Real Browser Acceptance Tests Passed in Google Chrome with 0 Console Errors)**

---

## 1. Executive Summary

During Phase 5.14, three cascading backend and frontend failures were investigated, isolated, and permanently resolved across VidyarthiAstra / PYQS Hub:

1. **Issue 1: Firestore Quota Exhaustion (`HTTP 429 RESOURCE_EXHAUSTED`)**
   - Server logs confirmed: `[UniversalFirestoreService] QUOTA EXHAUSTED: HTTP 429 RESOURCE_EXHAUSTED querying users/{uid} (Target Project: pyqs-hub-43bed, attempt 1/3). Retry-After: 30s.`
   - Authentication and role checking failed with `Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED)`.
2. **Issue 2: Mock-Test Catalog Unavailable**
   - The student catalog falsely displayed `"No published mock tests currently available."` despite published tests existing in the database.
3. **Issue 3: Mock-Test Startup Failure**
   - The test interface failed to start and presented `"Unable to Start Mock Test — This test currently has no questions loaded."` despite valid test questions existing in Firestore.

### Forensic Connection Established
Forensic analysis proved that these three issues formed a cascading chain of failure:
- **Missing Negative Caching in `UniversalFirestoreService`:** Querying `users/{uid}` for non-existent documents (e.g. freshly created or guest accounts) evicted cache entries on 404. Multiple concurrent components (`header.js`, `mock-test.js`, autosaves, attempt lookups) repeatedly hammered Cloud Firestore with un-cached reads, burning the daily read quota.
- **Missing Circuit Breaker on 429:** When Cloud Firestore returned HTTP 429, no cooldown was enforced. Subsequent requests 20ms later triggered fresh live outbound requests, triggering hundreds of 429 errors.
- **Silent Error Swallowing in `UniversalFirestoreService.listDocuments`:** When Firestore returned HTTP 429 during `listDocuments("mockTests")` or `listDocuments("mockQuestions")`, the error was caught and swallowed, silently returning an empty array `[]`.
- **False Empty Catalog (Issue 2):** `GET /api/mock-tests` received `[]` from `listDocuments("mockTests")` and returned HTTP 200 `{ success: true, count: 0, tests: [] }`. The frontend saw `publishedTests.length === 0` and displayed `#catalogEmpty` ("No published mock tests currently available"), converting a fatal database quota failure into a misleading successful empty catalog!
- **False Zero-Question Error (Issue 3):** `GET /api/mock-tests/:testId` received `[]` from `listDocuments("mockQuestions")` and returned HTTP 200 `{ test: {...}, questions: [] }`. The frontend checked `if (rawQuestions.length === 0)` and threw `Error("This test currently has no questions loaded.")`. Because the error lacked quota metadata, `renderTestSessionError` displayed `"Unable to Start Mock Test — This test currently has no questions loaded."`, completely masking the underlying Firestore 429 failure.

---

## 2. Root Cause Analysis & Technical Evidence

### Issue 1: Quota Exhaustion & Read Storms
- **File:** `server/services/admin/universalFirestoreService.js` (Lines 657–661)
- **Defect:** 
  ```javascript
  if (res.status === 404) {
      localDocCache.delete(legacyCacheKey);
      this._ttlDocCache.delete(scopedCacheKey);
      return null;
  }
  ```
  Every time a user document returned 404, it was purged from both caches. The very next call (from header navigation, mock-test session verification, or attempt creation) dispatched another live network read.
- **Defect:** No cooldown or circuit breaker existed when Cloud Firestore returned HTTP 429 with `Retry-After: 30s`. Outbound requests continued to be dispatched blindly.

### Issue 2: Swallowed Errors in Collection Listing
- **File:** `server/services/admin/universalFirestoreService.js` (Lines 794–805)
- **Defect:**
  ```javascript
  if (res.ok) {
      // populate resultsMap
  } else {
      break; // Silently breaks pagination loop on 429 or HTTP errors!
  }
  ...
  catch (err) {
      console.warn(`[UniversalFirestoreService] List collection notice:`, err.message);
  }
  return Array.from(resultsMap.values()); // Returns [] empty array!
  ```
  When Cloud Firestore was quota-exhausted (HTTP 429), `listDocuments("mockTests")` silently returned `[]`.
- **File:** `server/routes/mockTests.js` (Lines 223–227)
- **Defect:** Catch block did not inspect `isQuotaExhausted` or pass `Retry-After`, returning generic 500 when errors were caught, while swallowed errors returned HTTP 200 with empty array.
- **File:** `www/js/mock-test.js` (Lines 526–531)
- **Defect:**
  ```javascript
  if (publishedTests.length === 0) {
      testGrid.style.display = "none";
      catalogEmpty.style.display = "block"; // Falsely shows empty catalog!
      return;
  }
  ```

### Issue 3: Masked Question Retrieval Failures
- **File:** `server/services/mockTestService.js` (Lines 223–228)
- **Defect:**
  ```javascript
  const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
  const testQuestions = allQuestions.filter(...);
  ```
  Because `listDocuments` swallowed 429 and returned `[]`, `testQuestions` became `[]`.
- **File:** `server/routes/mockTests.js` (Line 288) returned HTTP 200 with `{ test: {...}, questions: [] }`.
- **File:** `www/js/mock-test.js` (Lines 971–973)
- **Defect:**
  ```javascript
  if (rawQuestions.length === 0) {
      throw new Error("This test currently has no questions loaded.");
  }
  ```
  Because the error was not classified as `isQuota`, `renderTestSessionError` rendered:
  `Title: "Unable to Start Mock Test"`
  `Desc: "This test currently has no questions loaded."`

---

## 3. Remediation Architecture

### 3.1 Bounded Negative Caching
In `server/services/admin/universalFirestoreService.js`:
- Added negative caching for HTTP 404 responses in `_ttlDocCache`:
  ```javascript
  if (res.status === 404) {
      localDocCache.delete(legacyCacheKey);
      const negativeTtlMs = typeof options.negativeTtlMs === "number" ? options.negativeTtlMs : ttlMs;
      this._addToTtlCache(scopedCacheKey, null, negativeTtlMs, true); // notFound: true
      return null;
  }
  ```
- Cached `notFound: true` entries return `null` immediately without dispatching any network fetch.
- Cache invalidation: Creating or modifying documents via `setDocument`, `saveImportedPackage`, or `commitBatchWrites` automatically overwrites or evicts negative entries.

### 3.2 Cooldown Circuit Breaker for HTTP 429
In `server/services/admin/universalFirestoreService.js`:
- Added static circuit breaker properties and helpers:
  - `_quotaCooldownUntil`: Timestamp until which outbound calls are paused.
  - `isQuotaCooldownActive()`: Returns boolean indicating active cooldown.
  - `getQuotaCooldownRemainingMs()`: Returns remaining cooldown in milliseconds.
  - `recordQuotaExhaustion(retryAfterSec, details)`: Trips breaker for `retryAfterSec` seconds.
  - `clearQuotaCooldown()`: Clears breaker for testing and recovery.
- Before issuing any network fetch in `getDocument`, `listDocuments`, and `commitBatchWrites`:
  ```javascript
  if (this.isQuotaCooldownActive() && !options.skipQuotaCooldown) {
      const remainingSec = Math.max(1, Math.ceil(this.getQuotaCooldownRemainingMs() / 1000));
      const quotaErr = new Error(`Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED)... Circuit breaker active, retry after ${remainingSec}s.`);
      quotaErr.code = "RESOURCE_EXHAUSTED";
      quotaErr.statusCode = 429;
      quotaErr.isQuotaExhausted = true;
      quotaErr.retryAfter = remainingSec;
      throw quotaErr;
  }
  ```
- **Read Elimination:** During the cooldown window, 100% of outbound HTTP requests to Cloud Firestore are eliminated.

### 3.3 Strict Error Propagation in `listDocuments`
In `server/services/admin/universalFirestoreService.js`:
- `listDocuments` checks `isQuotaCooldownActive()` before querying.
- When `res.status === 429` occurs, it trips the circuit breaker and throws a structured `quotaErr`.
- When `!res.ok` occurs, it throws a structured `httpErr` (e.g. 503 Service Unavailable).
- Removed error swallowing: Errors are re-thrown so callers never mistake a failure for an empty collection.

### 3.4 Structured API Quota Propagation
In `server/routes/mockTests.js`:
- `GET /` (catalog): Catches `isQuotaExhausted || statusCode === 429` and returns HTTP 429 with `code: "FIRESTORE_QUOTA_EXHAUSTED"`, `Retry-After` header, and user-facing error message.
- `GET /:testId` (test details & questions): Catches quota errors and returns HTTP 429 with `code: "FIRESTORE_QUOTA_EXHAUSTED"` and `Retry-After` header.
- `POST /:testId/attempts` (attempt creation): Returns HTTP 429 under quota limits.
- `PUT /attempts/:attemptId` (autosave): Returns HTTP 429 under quota limits.
- `POST /attempts/:attemptId/submit` (submission): Returns HTTP 429 under quota limits.

### 3.5 Client-Side Deduplication & Disambiguated UI States
In `www/js/mock-test.js`:
- Replaced direct uncached `/api/auth/session-role` calls with single-flight deduplicated `fetchUserSessionRole(currentUser)` from `header.js`.
- In `loadCatalog()`:
  - If response is HTTP 429 or error code is `FIRESTORE_QUOTA_EXHAUSTED`, renders distinct **"Database Read Quota Reached"** warning card with "Retry Catalog" button.
  - `#catalogEmpty` ("No published mock tests currently available") is strictly suppressed on API errors.
- In `startTestSession()`:
  - Propagates `statusCode: 429` and `code: "FIRESTORE_QUOTA_EXHAUSTED"` when question retrieval fails due to quota.
  - Only throws `"This test currently has no questions loaded."` when question retrieval succeeds (HTTP 200) and `questions.length === 0`.
- In `renderTestSessionError()`:
  - Quota errors render **"Database Read Quota Reached"** with amber styling and retry action.
  - Legitimate zero-question tests render **"Unable to Start Mock Test — This test currently has no questions loaded."** with red alert styling.

---

## 4. Verification & Automated Test Suite

### 4.1 Phase 5.14 Dedicated Test Suite (`tests/phase-5-14-firestore-quota-recovery.test.js`)
All 16 automated tests passed with 0 failures:

| Category | Test Case | Status | Duration |
| :--- | :--- | :---: | :---: |
| **Authentication & Caching** | 1.1 Caches 404 (document not found) negatively and prevents redundant Firestore reads | **PASS** | 83 ms |
| **Authentication & Caching** | 1.2 Invalidates negative cache immediately when the document is created or updated | **PASS** | 122 ms |
| **Authentication & Caching** | 1.3 Coalesces concurrent in-flight reads into a single network fetch | **PASS** | 66 ms |
| **Authentication & Caching** | 1.4 Trips circuit breaker on HTTP 429 and fails fast during cooldown without network calls | **PASS** | 42 ms |
| **Authentication & Caching** | 1.5 Express GET /api/auth/session-role returns HTTP 429 with Retry-After during quota exhaustion | **PASS** | 53 ms |
| **Authentication & Caching** | 1.6 Recovers automatically after circuit breaker cooldown expires | **PASS** | 1192 ms |
| **Catalog Resilience** | 2.1 Returns HTTP 429 (FIRESTORE_QUOTA_EXHAUSTED) instead of false empty catalog when Firestore is exhausted | **PASS** | 35 ms |
| **Catalog Resilience** | 2.2 Express router responds with HTTP 429 and Retry-After header when catalog fails due to quota | **PASS** | 19 ms |
| **Catalog Resilience** | 2.3 Distinguishes genuine zero-test catalog from database failure | **PASS** | 14 ms |
| **Question & Attempt Workflow** | 3.1 Propagates HTTP 429 when question loading fails due to Firestore quota exhaustion | **PASS** | 84 ms |
| **Question & Attempt Workflow** | 3.2 Cleanly separates genuine empty-question test from database failure | **PASS** | 1196 ms |
| **Question & Attempt Workflow** | 3.3 Propagates HTTP 429 during attempt creation (POST /api/mock-tests/:testId/attempts) | **PASS** | 66 ms |
| **Question & Attempt Workflow** | 3.4 Propagates HTTP 429 during answer autosave (PUT /api/mock-tests/attempts/:attemptId) | **PASS** | 118 ms |
| **Question & Attempt Workflow** | 3.5 Propagates HTTP 429 during attempt submission (POST /api/mock-tests/attempts/:attemptId/submit) | **PASS** | 43 ms |
| **Read Efficiency Benchmarks** | 4.1 Measures read reduction: 10 repeated session-role lookups for non-existent user (90% reduction) | **PASS** | 162 ms |
| **Read Efficiency Benchmarks** | 4.2 Measures read elimination: 10 calls during 429 cooldown produce 0 outbound network requests (100% reduction) | **PASS** | 47 ms |

### 4.2 Full Phase 5 Regression Test Suite
All 90 tests in the cumulative Phase 5 test suite passed cleanly with 0 failures:
- `tests/phase-5-14-firestore-quota-recovery.test.js`: 16/16 passed
- `tests/phase-5-13-review-status-filter.test.js`: 33/33 passed
- `tests/phase-5-11-mock-test-submission-dom.test.js`: 15/15 passed
- `tests/phase-5-10-mock-test-rendering.test.js`: 9/9 passed
- `tests/phase-5-9-1-independent-verification.test.js`: 17/17 passed

---

## 5. Real Google Chrome Browser Acceptance

Browser acceptance testing was executed via Playwright driving real Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`):
- **Script:** `scripts/run_phase_5_14_browser_acceptance.js`
- **Console Errors Detected:** **0**
- **Screenshots Captured:** **6/6 verified**

```
================================================================================
PHASE 5.14 — BROWSER ACCEPTANCE: FIRESTORE QUOTA, CATALOG & QUESTION RECOVERY
================================================================================

[TEST 1] Loading Mock Test Catalog with Published Tests...
  Rendered mock cards count: 3
  [SCREENSHOT CAPTURED] 01_catalog_published_mock_tests.png

[TEST 2] Simulating Firestore Quota Exhaustion (HTTP 429) on Catalog...
  Quota error card title: "Database Read Quota Reached"
  Is false empty catalog visible: false
  [SCREENSHOT CAPTURED] 02_catalog_quota_exhausted_state.png

[TEST 3] Simulating Quota Recovery & Catalog Re-render...
  Recovered mock cards count: 3
  [SCREENSHOT CAPTURED] 03_catalog_quota_recovered_success.png

[TEST 4] Simulating Mock-Test Startup Quota Failure...
  Session error card title: "Database Read Quota Reached"
  [SCREENSHOT CAPTURED] 04_test_startup_quota_exhausted_state.png

[TEST 5] Simulating Genuine Zero-Question Test Initialization...
  Empty question error title: "Unable to Start Mock Test"
  Empty question error desc: "This test currently has no questions loaded."
  [SCREENSHOT CAPTURED] 05_genuine_zero_questions_state.png

[TEST 6] Starting Valid Active Mock Test Session...
  Active question 1 text: "A body of mass 2 kg is moving with a velocity of 10 m/s. Its kinetic energy is:"
  Rendered palette button count: 5
  [SCREENSHOT CAPTURED] 06_active_mock_test_session.png

================================================================================
ALL 6 BROWSER ACCEPTANCE TESTS PASSED SUCCESSFULLY WITH REAL GOOGLE CHROME!
Console errors detected: 0
================================================================================
```

---

## 6. Screenshot Gallery & Visual Proof

All 6 screenshots were captured at full resolution (1366x850) and saved to both `phase_5_14_acceptance_screenshots/` and the artifact directory:

| Filename | Description | Verified Visual Behavior |
| :--- | :--- | :--- |
| `01_catalog_published_mock_tests.png` | Published Mock Tests Catalog | Renders 3 active published cards (NEET UG 2024, JEE Main 2024, RRB NTPC). All tags, badges, and Start buttons visible. |
| `02_catalog_quota_exhausted_state.png` | Catalog Quota Exhaustion (HTTP 429) | Distinct amber warning card: *"Database Read Quota Reached"* with Retry button. `#catalogEmpty` is strictly hidden. |
| `03_catalog_quota_recovered_success.png` | Catalog Quota Recovery | Clicking Retry Catalog after quota resets restores test grid cards immediately without reload. |
| `04_test_startup_quota_exhausted_state.png` | Test Startup Quota Failure | Starting test under 429 displays *"Database Read Quota Reached"*, strictly NOT claiming zero questions. |
| `05_genuine_zero_questions_state.png` | Genuine Zero-Question Test | Genuine 0-question test displays *"Unable to Start Mock Test — This test currently has no questions loaded."* |
| `06_active_mock_test_session.png` | Active Mock Test Session | Cleanly renders Question 1 (Physics), 4 option radio cards, 5-question palette, section tabs, and countdown timer. |

---

## 7. Read Efficiency & Quota Conservation Benchmarks

| Metric / Scenario | Baseline (Before Fix) | Phase 5.14 Implementation | Quota Savings / Efficiency |
| :--- | :---: | :---: | :---: |
| **10 Lookups for Unregistered UID** | 10 live network reads | **1 live network read (9 negative cache hits)** | **90% Read Reduction** |
| **Outbound Calls during 429 Cooldown (10 calls)** | 10 live outbound calls (causing 429 storm) | **0 outbound calls (fail fast via breaker)** | **100% Read Elimination** |
| **Catalog Fail-Closed Safety** | Swallowed to `[]`, shows false empty state | **Returns 429 with Retry-After header** | **Zero False Empty States** |
| **Question Retrieval Safety** | Swallowed to `[]`, claims "no questions" | **Returns 429 with Quota Card** | **Zero Misleading Zero-Question Alerts** |

---

## 8. Artifacts & Deliverables Summary

- [Universal Firestore Service](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/universalFirestoreService.js)
- [Mock Tests API Router](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/mockTests.js)
- [Client Mock Test Controller](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/www/js/mock-test.js)
- [Client Header Auth Controller](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/www/js/header.js)
- [Phase 5.14 Automated Test Suite](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/phase-5-14-firestore-quota-recovery.test.js)
- [Phase 5.14 Browser Acceptance Script](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/scripts/run_phase_5_14_browser_acceptance.js)
- [Screenshot 1: Catalog Published Mock Tests](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/01_catalog_published_mock_tests.png)
- [Screenshot 2: Catalog Quota Exhausted State](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/02_catalog_quota_exhausted_state.png)
- [Screenshot 3: Catalog Quota Recovered Success](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/03_catalog_quota_recovered_success.png)
- [Screenshot 4: Test Startup Quota Exhausted State](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/04_test_startup_quota_exhausted_state.png)
- [Screenshot 5: Genuine Zero Questions State](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/05_genuine_zero_questions_state.png)
- [Screenshot 6: Active Mock Test Session](file:///c:/Users/RUPENDRA/Documents/VidyarthiAstra-current/phase_5_14_acceptance_screenshots/06_active_mock_test_session.png)
