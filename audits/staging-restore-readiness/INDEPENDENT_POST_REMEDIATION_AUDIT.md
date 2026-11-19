# Milestone 3 — Independent Post-Remediation Security Verification Audit

**Audit Date:** 2026-11-14T02:10:00+05:30  
**Auditor:** Independent Senior Firebase/Firestore Security Auditor & Code Integrity Specialist  
**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Production Project:** `pyqs-hub-43bed`  
**Production Project Number:** `766070215379`  
**Reference Report:** [audits/staging-restore-readiness/CODE_REMEDIATION_REPORT.md](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/audits/staging-restore-readiness/CODE_REMEDIATION_REPORT.md)  
**Deliverable File:** `audits/staging-restore-readiness/INDEPENDENT_POST_REMEDIATION_AUDIT.md`

---

## 1. Overall Governance Verdict

### Local Code & Architectural Project Isolation: **PASS**
All local code fixes claimed in [CODE_REMEDIATION_REPORT.md](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/audits/staging-restore-readiness/CODE_REMEDIATION_REPORT.md) have been independently inspected, confirmed in source code, and verified offline. Hardcoded production project fallbacks have been completely excised from all active server routes, services, and administrative pipelines. The offline test suite passed with 100% success (**33/33 suites, 616/616 tests passed**).

### Cloud Infrastructure & Staging Deployment: **BLOCKED / STRICT NO-GO**
Live staging restore drills and production migration remain strictly blocked. Critical cloud infrastructure prerequisites—including the revocation of the compromised local production key, the provisioning of an isolated staging GCP project in `asia-south1`, dedicated staging credentials, and cross-project backup bucket IAM—require authorized Cloud Administrator action in Google Cloud Platform and cannot be resolved locally.

---

## 2. Independently Verified Fixes

The following fixes were independently verified by inspecting the actual source code:

### 2.1 Complete Removal of Hardcoded Production Fallbacks (BLK-04)
Every occurrence of `|| "pyqs-hub-43bed"` and `?? "pyqs-hub-43bed"` in active application routes and services has been removed:
- [server/routes/papers.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/papers.js#L14-L20): Global fallback removed. `getActiveProjectId()` mandates non-empty `process.env.FIREBASE_PROJECT_ID` and validates format via `validateProjectIdFormat`. Unset or invalid configuration throws immediately, failing closed.
- [server/routes/studyResources.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/studyResources.js#L12-L18): Global fallback removed. Implemented `getActiveProjectId()`. Fails closed if unset.
- [server/services/pyqLibraryService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/pyqLibraryService.js#L7-L13): Fallback constant removed. `getActiveProjectId(explicitProjectId)` validates target project. All 8 query methods resolve the database endpoint dynamically.
- [server/services/questionExtractionService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/questionExtractionService.js#L12-L18): Fallback constant removed. Dynamic validation in `writeQuestionsToFirestore` and `processPaperExtraction`.
- [server/services/paperSearchService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/paperSearchService.js#L12-L18): Fallback constant removed. Project resolution placed outside search `try/catch` block to guarantee fail-closed behavior on missing project configuration.
- [server/services/admin/adminAuthService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/adminAuthService.js#L80-L105): Ambient fallback removed. `getAdminTargetProjectId()` validates format. `requireAdmin` instantiates and attaches `req.adminClient = UniversalFirestoreService.forProject(targetProject)`. Returns HTTP 503 if target project cannot be determined.
- [server/routes/admin.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/admin.js#L50-L75): Hardcoded production fallback removed. Replaced static `UniversalFirestoreService` calls (`/users`, `/mockQuestions/:questionId`, `/import/jobs/:jobId/mock-tests`) with `req.adminClient`.

### 2.2 Elimination of Ambient Migration Fallbacks (BLK-05)
In [server/services/admin/historicalAttemptMigrationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L33-L61):
- Added centralized `_getClient({ client, targetProjectId, hasInMemoryDataset, operationName })`.
- Strictly rejects any call to live Firestore that lacks an explicit `UniversalFirestoreClient` instance or validated `targetProjectId`.
- Prohibits ambient fallback to `process.env.FIREBASE_PROJECT_ID`.
- Verifies that supplied client is an actual `instanceof UniversalFirestoreClient`.
- Rejects conflicting `client.projectId` and `targetProjectId`.
- Rejects numeric GCP project numbers (`766070215379`).
- Propagates `firestoreClient` through all batch commits, intermediate checkpoint writes ([historicalAttemptMigrationService.js#L884](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L884)), and final checkpoint updates ([historicalAttemptMigrationService.js#L903](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L903)).

### 2.3 Subcollection Coverage in Firestore Backup Scope (BLK-08)
In [scripts/preflight-backup-check.sh](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/scripts/preflight-backup-check.sh#L124-L135):
- Eliminated default `--collection-ids` flag that previously omitted subcollections (e.g. `mockTests/{testId}/sections`).
- Defaulted execution to a whole-database export (`gcloud firestore export "${DESTINATION}"`), guaranteeing full preservation of nested subcollections.
- Retained optional collection filtering via `EXPORT_COLLECTION_IDS` environment variable.

### 2.4 Immutable Project Client Binding
In [server/services/admin/universalFirestoreService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/universalFirestoreService.js#L17-L85):
- `UniversalFirestoreClient` freezes its instance (`Object.freeze(this)`).
- `_resolveOptions` validates that callers do not pass conflicting `options.projectId`.
- Rejects ambient fallback in static `UniversalFirestoreService.projectId` getter with a fatal error:
  `"[UniversalFirestoreService] FATAL: No Firestore project ID configured. An explicit project ID or bound client instance is mandatory."`

---

## 3. Discrepancies & Items Requiring Attention

### 3.1 Staging Alias Inconsistency in `.firebaserc` (High Attention)
- **Observed Inconsistency:**
  - [.firebaserc](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/.firebaserc#L5): `"staging": "pyqs-hub-staging"`
  - Proposed staging project in [STAGING_RESTORE_EXECUTION_RUNBOOK.md](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/audits/staging-restore-readiness/STAGING_RESTORE_EXECUTION_RUNBOOK.md#L46), [STAGING_RESTORE_PREREQUISITES.md](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/audits/staging-restore-readiness/STAGING_RESTORE_PREREQUISITES.md#L15), and `ALLOWED_STAGING_PROJECTS`: `staging-vidyarthiastra`.
- **Impact Assessment:**
  - `pyqs-hub-staging` is NOT listed in `ALLOWED_STAGING_PROJECTS` in [server/services/admin/postBackupReconciliationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/postBackupReconciliationService.js#L11-L15) (which permits `demo-vidyarthiastra`, `staging-vidyarthiastra`, and `staging-pyqs-hub`).
  - Does it resolve to production? **No.** `pyqs-hub-staging` is distinct from production `pyqs-hub-43bed`. Running `firebase use staging` will never direct writes to production.
  - However, running Firebase CLI commands with `staging` will target `pyqs-hub-staging` instead of `staging-vidyarthiastra`.
- **Exact Correction Required:**
  Update [.firebaserc](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/.firebaserc) to align with the operational runbook and allowlist:
  ```json
  {
    "projects": {
      "default": "pyqs-hub-43bed",
      "production": "pyqs-hub-43bed",
      "staging": "staging-vidyarthiastra"
    }
  }
  ```

### 3.2 Legacy / Standalone Verification Scripts
- Standalone developer scratch scripts outside the main application runtime retain old defaults:
  - `scripts/verify-study-resources-counter.js`: Defaults to `127.0.0.1:8088` (Firestore Emulator).
  - `scripts/test-frontend-integration-flow.js`, `scripts/seed-emulator-study-resources.js`: Targeted at local emulator flows.
  - `scripts/fetch-jee-q13-rest.js`, `scripts/fetch-q5-rest.js`: Hardcoded public question read URLs.
- **Verdict:** These are standalone inspection scripts not imported by the Express server or runtime API routes. However, operators should be aware not to run unvetted scripts in staging.

---

## 4. Backup Export & Restore Compatibility Verdict

| Requirement | Implementation Finding | Status |
| :--- | :--- | :---: |
| **Full Database Export** | `preflight-backup-check.sh` omits `--collection-ids` by default, triggering whole-database export. | **VERIFIED** |
| **Subcollection Preservation** | Firestore whole-database export natively captures all root and nested subcollections (`mockTests/{testId}/sections`, etc.). | **VERIFIED** |
| **Export Artifact Structure** | Cold export produces timestamped `gs://<bucket>/pre-migration-<timestamp>` containing `*.overall_export_metadata`. Verified by `preflight-backup-check.sh` polling gate. | **VERIFIED** |
| **Import / Upsert Behavior** | `gcloud firestore import` is additive. Document deletions are NOT performed by import. This necessitates `scripts/reset-staging-baseline.js` before import to avoid dirty staging data. | **VERIFIED** |
| **Source & Destination Project Gates** | Backup script checks project ID `pyqs-hub-43bed` and number `766070215379`. Staging import script rejects any project containing `prod` or matching `pyqs-hub-43bed`. | **VERIFIED** |
| **Reconciliation for Post-Backup Writes** | `PostBackupReconciliationService` tracks `_updateTime` and isolates both new documents and modified existing documents without assuming import deletes documents. | **VERIFIED** |
| **Live Bucket Existence & Cloud Permissions** | `gs://pyqs-hub-43bed-backups-asia-south1` and cross-project IAM grants cannot be verified locally. | **NOT VERIFIED (Cloud Admin Required)** |

---

## 5. Test Integrity & Execution Evidence

### 5.1 Test Discovery and Execution Audit
- Total test files in `tests/`: **41 files**
  - **33 Unit / Integration Suites:** Discovered and executed via `scratch/run_all_tests.mjs`.
  - **4 Emulator Suites:** (`cascade-deletion-emulator.test.js`, `deletion-resilience-emulator.test.js`, `firestore-emulator-recovery.test.js`, `firestore-rules-emulator.test.js`). These assert `FIRESTORE_EMULATOR_HOST` and target `demo-vidyarthiastra`. They fail closed if the local emulator is absent.
  - **4 Browser / UI Suites:** (`browser-admin-workflow.test.js`, `browser-four-tasks.test.js`, `browser-mock-test-access.test.js`, `browser-mock-test-deletion.test.js`). These test web UI flows using Playwright/Chromium against local web server.
- The test runner `scratch/run_all_tests.mjs` runs tests with `NODE_ENV=test` and `FIREBASE_PROJECT_ID=demo-vidyarthiastra`.
- If any test fails, the runner records the failure in an array and exits with code `1` (`process.exit(1)`).

### 5.2 Independent Test Runner Execution Output
Executed command: `node scratch/run_all_tests.mjs`  
Exit code: **0**

```
Discovered 33 unit/integration test files to execute (plus 4 emulator suites).
Running admin-api-integration.test.js... PASSED (27/27)
Running admin-import-pipeline.test.js... PASSED (14/14)
Running admin-pipeline-extended.test.js... PASSED (24/24)
Running admin-user-management.test.js... PASSED (22/22)
Running bpsc-end-to-end-workflow.test.js... PASSED (19/19)
Running bpsc-pipeline.test.js... PASSED (7/7)
Running data-serialization-audit.test.js... PASSED (10/10)
Running exam-profile-registry.test.js... PASSED (55/55)
Running firestore-admin-auth.test.js... PASSED (36/36)
Running firestore-security-rules.test.js... PASSED (7/7)
Running historical-attempt-migration.test.js... PASSED (12/12)
Running hostinger-startup-architecture.test.js... PASSED (9/9)
Running jee-main-2026-pipeline.test.js... PASSED (15/15)
Running milestone-2-defect-remediation.test.js... PASSED (34/34)
Running milestone-3-final-route-coverage-recovery.test.js... PASSED (7/7)
Running milestone-3-recovery-integrity-audit.test.js... PASSED (8/8)
Running mock-test-access-control.test.js... PASSED (16/16)
Running mock-test-concurrency-def-conc-01.test.js... PASSED (10/10)
Running mock-test-deletion.test.js... PASSED (8/8)
Running mock-test-engine-comprehensive.test.js... PASSED (20/20)
Running mock-test-engine-safety.test.js... PASSED (8/8)
Running mock-test-performance-and-review.test.js... PASSED (33/33)
Running mock-test-search-sort.test.js... PASSED (28/28)
Running post-backup-reconciliation.test.js... PASSED (36/36)
Running pyq-library.test.js... PASSED (21/21)
Running question-extraction-hybrid.test.js... PASSED (14/14)
Running search-fallback.test.js... PASSED (21/21)
Running section-attribution-remediation.test.js... PASSED (9/9)
Running test-auth-isolation.test.js... PASSED (30/30)
Running universal-scoring-engine.test.js... PASSED (29/29)
Running upsc-independent-verification.test.js... PASSED (7/7)
Running upsc-pipeline.test.js... PASSED (10/10)
Running upsc-production-workflow-verification.test.js... PASSED (10/10)

=======================================================
TOTAL SUITES EXECUTED : 33
TOTAL TESTS EXECUTED  : 616
TOTAL PASSED          : 616
TOTAL FAILED          : 0
=======================================================
```

### 5.3 Test Offline & Security Isolation Verification
- [tests/test-auth-isolation.test.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js#L32-L75): Verifies that unit tests return synthetic test tokens (`test-auth-token`) without network calls.
- Verifies that fake test tokens are strictly blocked for production `pyqs-hub-43bed` ([test-auth-isolation.test.js#L42-L73](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js#L42-L73)).
- Verifies that production credentials (`prodSa`) cannot be used against staging targets ([test-auth-isolation.test.js#L140-L155](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js#L140-L155)).
- Zero production cloud requests were made during the test run.

---

## 6. Historical Data Safety & Integrity Verdict

Inspected [server/services/admin/historicalAttemptMigrationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js) and test suites:

1. **Zero Historical Rescoring:**
   - Historical results are transformed purely into Schema v2 format with `totalScore: result.totalScore` and `breakdown: result.breakdown` preserved verbatim ([historicalAttemptMigrationService.js#L435-L440](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L435-L440)).
   - `verifyScorePreservation` explicitly compares `migratedResult.totalScore === originalResult.totalScore`, throwing `SCORE_MUTATION_DETECTED` on any variance ([historicalAttemptMigrationService.js#L461-L464](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L461-L464)).
   - Question marks awarded are checked individually, throwing `QUESTION_SCORE_MUTATION` if any individual score differs ([historicalAttemptMigrationService.js#L486-L492](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L486-L492)).
2. **Rounding Drift Protection:**
   - In BPSC 69th and UPSC Prelims examinations where individual negative marks (e.g. -0.333 vs -0.3333) lead to small rounding differences, `totalScore` remains authoritative and unchanged. Verified by [tests/milestone-3-recovery-integrity-audit.test.js#L30-L50](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/milestone-3-recovery-integrity-audit.test.js#L30-L50).
3. **Manual Review State Preservation:**
   - If any breakdown item has `pending_manual_review`, `requiresManualReview: true`, or `manualEvaluationStatus: "pending"`, the migrated result sets `requiresManualEvaluation: true` and counts `pendingReviewCount` ([historicalAttemptMigrationService.js#L394-L411](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L394-L411)).
4. **Concurrency & Rollback Safety:**
   - Batch writes enforce Firestore `currentDocument: { updateTime: attempt._updateTime }` preconditions ([historicalAttemptMigrationService.js#L840-L843](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L840-L843)).
   - A concurrent modification (HTTP 412) aborts the batch atomically without partial mutation or checkpoint advancement.
   - Ambiguous network timeouts resume 100% idempotently with 0 duplicate writes, skipping already-migrated records. Verified by [tests/milestone-3-final-route-coverage-recovery.test.js#L489-L580](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/milestone-3-final-route-coverage-recovery.test.js#L489-L580).

**Verdict on Historical Data Safety:** **PASS — FULLY VERIFIED.**

---

## 7. Remaining Cloud Blockers Register

The following items are external cloud prerequisites that remain **OPEN** and require authorized Cloud Administrator intervention:

| Blocker ID | Description | Status | Verification Authority Required |
| :--- | :--- | :---: | :--- |
| **BLK-01** | Production SA Key (`serviceAccountKey.json`) in workspace unrevoked | **OPEN** | Cloud Administrator via `gcloud iam service-accounts keys list` & delete |
| **BLK-02** | Staging GCP project (`staging-vidyarthiastra`) unprovisioned | **OPEN** | Cloud Administrator via `gcloud projects describe` & Firestore init in `asia-south1` |
| **BLK-03** | Staging Service Account & Key missing | **OPEN** | Cloud Administrator via `gcloud iam service-accounts create` |
| **BLK-06a**| Backup bucket `gs://pyqs-hub-43bed-backups-asia-south1` unverified | **OPEN** | Cloud Administrator via `gcloud storage buckets describe` |
| **BLK-06b**| Cross-project IAM (`roles/storage.objectViewer`) for staging SA ungranted | **OPEN** | Cloud Administrator via `gcloud storage buckets add-iam-policy-binding` |
| **BLK-09** | Authoritative recovery cold backup unexecuted in production | **OPEN** | Operator execution under maintenance mode using `preflight-backup-check.sh` |
| **BLK-10** | Live staging restore drill unexecuted | **OPEN** | Operator execution using `preflight-staging-import-check.sh` |

---

## 8. Exact Next Action

1. **Local Developer Action (Immediate):**
   - Align [.firebaserc](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/.firebaserc) line 5: change `"pyqs-hub-staging"` to `"staging-vidyarthiastra"`.
2. **Cloud Administrator Action (Prerequisite for Live Drill):**
   Execute the four cloud provisioning commands in Google Cloud Console / Cloud Shell:
   - **Key Revocation:** Delete exposed key ID on `firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com` and purge local `serviceAccountKey.json`.
   - **Staging Project:** Create `staging-vidyarthiastra` with Firestore Native mode in `asia-south1`.
   - **Staging SA:** Create `staging-app-sa@staging-vidyarthiastra.iam.gserviceaccount.com` with `roles/datastore.user`.
   - **Backup Bucket & IAM:** Create `gs://pyqs-hub-43bed-backups-asia-south1` in `asia-south1`, bind `roles/storage.objectAdmin` to production Firestore service agent (`service-766070215379@gcp-sa-firestore.iam.gserviceaccount.com`), and bind `roles/storage.objectViewer` to the staging Firestore service agent.
3. **Live Operations Status:**
   - **Live Production Migration:** **STRICT NO-GO** until staging drill is successfully executed and signed off.

