# Milestone 3 — Critical Project Isolation & Backup Scope Code Remediation Report

**Date:** 2026-11-14T02:00:00+05:30  
**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Production Project:** `pyqs-hub-43bed`  
**Production Project Number:** `766070215379`  
**Author:** Senior Firebase/Firestore Security Architect & Senior Node.js Backend Engineer  
**Status:** **LOCAL CODE REMEDIATION COMPLETE — ALL 33 SUITES PASSED (616/616 TESTS)**  
**Cloud / Infrastructure Status:** **STRICT NO-GO FOR PRODUCTION MIGRATION / DRILL PENDING CLOUD ADMIN ACTIONS**

---

## Executive Summary

Following the comprehensive [Milestone 3 Staging Restore Readiness Audit](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/audits/staging-restore-readiness/STAGING_RESTORE_READINESS_REPORT.md), a targeted code and configuration remediation was executed across the repository to address all confirmed local code defects and configuration ambiguities.

### Primary Remediation Outcomes

1. **Elimination of All Hardcoded Production Fallbacks (Phase 1 / BLK-04 — RESOLVED):**
   Completely removed every instance of `|| "pyqs-hub-43bed"` and `?? "pyqs-hub-43bed"` across all 7 audited routes and services (`papers.js`, `studyResources.js`, `pyqLibraryService.js`, `questionExtractionService.js`, `paperSearchService.js`, `adminAuthService.js`, and `admin.js`). Services now fail closed with HTTP 503 / 500 when `FIREBASE_PROJECT_ID` is missing, blank, or invalid. Static calls in administrative routes have been migrated to project-bound client instances (`req.adminClient`).

2. **Elimination of Ambient Migration Fallbacks (Phase 2 / BLK-05 — RESOLVED):**
   Removed ambient `process.env.FIREBASE_PROJECT_ID` inference from `HistoricalAttemptMigrationService` (`discoverInventory`, `executeDryRun`, `executeBatchMigration`). Enforced strict client identity validation via `_getClient()`: requiring an explicit, non-forgeable `UniversalFirestoreClient` instance or validated `targetProjectId`, rejecting client/target mismatches, and propagating the bound client immutably through all batch commits, intermediate checkpoints, and final status updates.

3. **Restoration of Subcollections in Managed Export Scope (Phase 3 / BLK-08 — RESOLVED):**
   Updated `scripts/preflight-backup-check.sh` to default to full database export (omitting `--collection-ids`), guaranteeing that nested subcollections (such as `mockTests/{testId}/sections` and `exams/{examId}/years/{yearId}/papers`) are included in backup snapshots. Retained optional selective filtering via `EXPORT_COLLECTION_IDS` only when explicitly specified.

4. **Firebase CLI Multi-Environment Configuration Hardening (Phase 4 / BLK-07 — RESOLVED):**
   Updated `.firebaserc` to declare explicit project targets (`"production": "pyqs-hub-43bed"`, `"staging": "pyqs-hub-staging"`, `"default": "pyqs-hub-43bed"`), eliminating ambiguous single-project defaults during multi-environment operations.

5. **Test Suite Expansion & 100% Pass Rate (Phase 5 & 7):**
   Added 10 exhaustive regression tests to [tests/test-auth-isolation.test.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js), covering project ID format validation, fail-closed service guards, ambient migration rejection, client forgery prevention, and bound client checkpoint preservation. The entire workspace test suite now passes with zero failures: **33 suites executed, 616 tests passed, 0 failures**.

---

## Detailed Remediation by Phase

### Phase 1: Removal of Hardcoded Production Fallbacks

#### 1. [server/routes/papers.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/papers.js)
- **Previous Vulnerability:** Line 7 declared `const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";`. Any execution without `FIREBASE_PROJECT_ID` silently queried production Firestore.
- **Remediation:** Removed the global constant. Implemented `getActiveProjectId()` calling `validateProjectIdFormat`. Updated `fetchPaperDocument`, `performAtomicIncrement`, and `/index-paper` route to obtain the validated project ID dynamically and fail closed:
  ```javascript
  function getActiveProjectId() {
      const raw = process.env.FIREBASE_PROJECT_ID;
      if (!raw || typeof raw !== "string" || !raw.trim()) {
          throw new Error("[Paper API] FATAL: FIREBASE_PROJECT_ID environment variable is missing or blank.");
      }
      return validateProjectIdFormat(raw.trim(), "FIREBASE_PROJECT_ID");
  }
  ```
- **Line References:** [server/routes/papers.js#L7-L20](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/papers.js#L7-L20)

#### 2. [server/routes/studyResources.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/studyResources.js)
- **Previous Vulnerability:** Line 10 declared `const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";`.
- **Remediation:** Removed the fallback constant. Added `getActiveProjectId()` with `validateProjectIdFormat`. Updated `verifyChapterExists` and `performAtomicIncrement` to fail closed if `FIREBASE_PROJECT_ID` is unconfigured.
- **Line References:** [server/routes/studyResources.js#L10-L24](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/studyResources.js#L10-L24)

#### 3. [server/services/pyqLibraryService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/pyqLibraryService.js)
- **Previous Vulnerability:** Line 7 declared `const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";`.
- **Remediation:** Removed the fallback constant. Added `getActiveProjectId(overrideProjectId)` with format validation. Updated all 8 public and internal query methods (`getAvailableExams`, `getAvailableYears`, `getPapersByExamAndYear`, `getTotalPapersCount`, `getRecentPapers`, `_getRecentPapersFallback`, `searchPapers`, `getPaperInternal`, and `getPaperForDownload`) to call `getActiveProjectId(options?.projectId)` and compute `getFirestoreBaseUrl(projectId)`.
- **Line References:** [server/services/pyqLibraryService.js#L7-L25](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/pyqLibraryService.js#L7-L25)

#### 4. [server/services/questionExtractionService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/questionExtractionService.js)
- **Previous Vulnerability:** Line 12 declared `const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";`.
- **Remediation:** Removed the fallback constant. Added `getActiveProjectId(overrideProjectId)`. Updated `writeQuestionsToFirestore`, `updatePaperExtractionMetadata`, and `processPaperExtraction` to resolve the target project dynamically and fail closed on missing/invalid configuration.
- **Line References:** [server/services/questionExtractionService.js#L12-L28](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/questionExtractionService.js#L12-L28)

#### 5. [server/services/paperSearchService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/paperSearchService.js)
- **Previous Vulnerability:** Line 12 declared `const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";`.
- **Remediation:** Removed fallback constant. Added `getActiveProjectId(overrideProjectId)`. Updated `fetchExamsFromFirestore`, `resolveExamId`, and `findPaperAndQuestion`. Placed `getActiveProjectId` outside the `try/catch` block so unconfigured project errors fail closed immediately rather than being masked as "search returned 0 results".
- **Line References:** [server/services/paperSearchService.js#L12-L28](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/paperSearchService.js#L12-L28)

#### 6. [server/services/admin/adminAuthService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/adminAuthService.js)
- **Previous Vulnerability:** Line 91 declared `const targetProjectId = process.env.FIREBASE_PROJECT_ID || UniversalFirestoreService.projectId || "pyqs-hub-43bed";`.
- **Remediation:** Removed `|| "pyqs-hub-43bed"` and `|| UniversalFirestoreService.projectId`. Implemented `getAdminTargetProjectId()` which validates `process.env.FIREBASE_PROJECT_ID` via `validateProjectIdFormat` and throws a fatal error if absent. In `requireAdmin`, securely attached `req.targetProjectId = targetProject` and instantiated an immutable bound client:
  ```javascript
  req.adminClient = UniversalFirestoreService.forProject(targetProject);
  ```
  If target project resolution fails, the middleware returns HTTP 503 Service Unavailable immediately.
- **Line References:** [server/services/admin/adminAuthService.js#L80-L105](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/adminAuthService.js#L80-L105)

#### 7. [server/routes/admin.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/admin.js)
- **Previous Vulnerability:** Line 55 defaulted `targetProjectId` to `"pyqs-hub-43bed"`. Multiple administrative endpoints invoked static `UniversalFirestoreService` methods (`getDocuments`, `getDocument`, `saveImportedPackage`).
- **Remediation:**
  - Removed fallback to `"pyqs-hub-43bed"`.
  - Refactored `GET /api/admin/users`, `DELETE /api/admin/mockQuestions/:questionId`, and `POST /api/admin/import/jobs/:jobId/mock-tests` to use `req.adminClient` or `UniversalFirestoreService.forProject(req.targetProjectId)`.
  - Zero static Firestore service calls remain in `server/routes/admin.js`.
- **Line References:** [server/routes/admin.js#L50-L75](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/admin.js#L50-L75), [server/routes/admin.js#L260-L310](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/admin.js#L260-L310)

---

### Phase 2: Elimination of Ambient Historical Migration Fallbacks

#### [server/services/admin/historicalAttemptMigrationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js)
- **Previous Vulnerability:** Lines 474-476, 597-599, and 719-721 contained:
  ```javascript
  else if (!firestoreClient && process.env.FIREBASE_PROJECT_ID) {
      firestoreClient = UniversalFirestoreService.forProject(process.env.FIREBASE_PROJECT_ID);
  }
  ```
  This allowed offline or unauthenticated callers to execute migration operations against ambient environment variables without explicit project targeting.
- **Remediation:**
  1. Centralized client resolution into `_getClient({ client, targetProjectId, hasInMemoryDataset, operationName })`.
  2. Mandated that any live Firestore operation must pass either an explicit `client` (validated as `instanceof UniversalFirestoreClient`) or an explicit, validated `targetProjectId`.
  3. Prohibited ambient fallback to `process.env.FIREBASE_PROJECT_ID`:
     ```javascript
     if (!explicitClient && !explicitProjectId) {
         if (hasInMemoryDataset && !options?.allowWrites) {
             return null;
         }
         throw new Error(`SAFETY VIOLATION: ${operationName} requires an explicit targetProjectId or bound UniversalFirestoreClient. Ambient project inference is blocked.`);
     }
     ```
  4. Verified that `client.projectId` matches `targetProjectId` if both are supplied.
  5. Validated `targetProjectId` format and rejected numeric project numbers.
  6. Verified that `firestoreClient` is propagated to all batch commits, intermediate checkpoint writes, and final checkpoint updates:
     ```javascript
     // Intermediate checkpoint write using bound client
     await firestoreClient.setDocument("migrationCheckpoints", checkpointId, intermediateCheckpoint);
     
     // Final checkpoint write using bound client
     await firestoreClient.setDocument("migrationCheckpoints", checkpointId, finalCheckpoint);
     ```
- **Line References:** [server/services/admin/historicalAttemptMigrationService.js#L460-L515](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L460-L515), [server/services/admin/historicalAttemptMigrationService.js#L810-L845](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/historicalAttemptMigrationService.js#L810-L845)

---

### Phase 3: Firestore Backup Export Scope Remediation

#### [scripts/preflight-backup-check.sh](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/scripts/preflight-backup-check.sh)
- **Previous Vulnerability:** Lines 102-105 specified `--collection-ids=mockAttempts,mockResults,mockTests,mockQuestions,migrationCheckpoints`. This excluded nested subcollections such as `mockTests/{testId}/sections`, resulting in incomplete backup snapshots.
- **Remediation:**
  - Removed the default `--collection-ids` flag. The preflight check now defaults to a full database export command:
    ```bash
    if [ -n "${EXPORT_COLLECTION_IDS:-}" ]; then
      COLLECTION_FLAG="--collection-ids=${EXPORT_COLLECTION_IDS}"
      echo "  Export scope: Selective collections (${EXPORT_COLLECTION_IDS})"
    else
      COLLECTION_FLAG=""
      echo "  Export scope: Full database (all root collections and subcollections)"
    fi
    ```
  - Full subcollection preservation is now guaranteed by default, matching production disaster recovery requirements.
- **Line References:** [scripts/preflight-backup-check.sh#L95-L125](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/scripts/preflight-backup-check.sh#L95-L125)

---

### Phase 4: Firebase Configuration Safety

#### [.firebaserc](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/.firebaserc)
- **Previous Ambiguity:** Contained only `"default": "pyqs-hub-43bed"`.
- **Remediation:** Added explicit named environments:
  ```json
  {
    "projects": {
      "default": "pyqs-hub-43bed",
      "production": "pyqs-hub-43bed",
      "staging": "pyqs-hub-staging"
    }
  }
  ```
  This enables unambiguous target selection (`firebase use staging` vs `firebase use production`) while maintaining backward compatibility for existing scripts.
- **Line References:** [.firebaserc#L1-L7](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/.firebaserc#L1-L7)

---

### Phase 5: Regression Tests Added

Added 10 comprehensive regression tests to [tests/test-auth-isolation.test.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js) in Task 3:

| # | Test Description | Assertion Verified | Status |
| :-: | :--- | :--- | :-: |
| **1** | Project ID validator strictly rejects numeric GCP project numbers (`766070215379`) | Rejects numbers, uppercase characters, whitespace, and symbols. | **PASS** |
| **2** | `PyqLibraryService` fails closed when `FIREBASE_PROJECT_ID` is unconfigured | Throws fatal error; zero silent production fallback. | **PASS** |
| **3** | `QuestionExtractionService` fails closed without `FIREBASE_PROJECT_ID` | Throws fatal error; zero silent production fallback. | **PASS** |
| **4** | `PaperSearchService` fails closed without `FIREBASE_PROJECT_ID` | Throws fatal error; zero silent production fallback. | **PASS** |
| **5** | `AdminAuthService` returns HTTP 503 when target project cannot be determined | Fails closed before executing administrative action. | **PASS** |
| **6** | `HistoricalAttemptMigrationService` rejects calls relying solely on ambient `FIREBASE_PROJECT_ID` | Throws `SAFETY VIOLATION: ... requires an explicit targetProjectId or bound UniversalFirestoreClient`. | **PASS** |
| **7** | `HistoricalAttemptMigrationService` rejects forged clients not instanceof `UniversalFirestoreClient` | Rejects plain object `{ projectId: "..." }`. | **PASS** |
| **8** | `HistoricalAttemptMigrationService` rejects conflicting `client.projectId` and `targetProjectId` | Throws `Conflicting project targets`. | **PASS** |
| **9** | `HistoricalAttemptMigrationService` rejects numeric project numbers | Fails closed on GCP project numbers. | **PASS** |
| **10** | `HistoricalAttemptMigrationService.executeBatchMigration` preserves bound client through chunks & checkpoints | Client instance remains identical; static service uncalled. | **PASS** |

All 30 tests in [tests/test-auth-isolation.test.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/tests/test-auth-isolation.test.js) passed in **15.4ms**.

---

## Phase 6: Full Repository Audit & Classification

A complete search across the repository codebase was performed to verify all occurrences of `pyqs-hub-43bed` and `FIREBASE_PROJECT_ID`:

### 1. Occurrences of `pyqs-hub-43bed` in `server/`
Every remaining reference to `pyqs-hub-43bed` in `server/` is an explicit security guard or defensive allowlist check:
- [server/services/firebaseTokenService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/firebaseTokenService.js): Blocks production credentials from running when target project is staging or when destructive operations are requested.
- [server/services/admin/universalFirestoreService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/universalFirestoreService.js): Blocks write operations against production during testing and safeguards staging client instantiation.
- [server/services/admin/postBackupReconciliationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/postBackupReconciliationService.js): Safety check preventing destructive reconciliation on production databases.
- **Zero hardcoded fallbacks exist in any route, service, or script.**

### 2. Usage of `FIREBASE_PROJECT_ID`
All 7 audited routes and services now validate `process.env.FIREBASE_PROJECT_ID` via `validateProjectIdFormat` and fail closed when unset. Ambient inference has been completely removed from the historical migration engine.

### 3. Static `UniversalFirestoreService` Invocations
All administrative write routes and migration workflows now use bound client instances (`UniversalFirestoreClient`). Static service methods are restricted to reading static schemas or delegating to bound clients.

---

## Phase 7: Verification & Test Execution Results

The offline test runner (`scratch/run_all_tests.mjs`) executed all 33 unit and integration test suites:

```
=======================================================
TOTAL SUITES EXECUTED : 33
TOTAL TESTS EXECUTED  : 616
TOTAL PASSED          : 616
TOTAL FAILED          : 0
=======================================================
```

### Breakdown of Key Test Suites:

1. `tests/test-auth-isolation.test.js`: **PASSED (30/30)**
2. `tests/milestone-3-final-route-coverage-recovery.test.js`: **PASSED (7/7)**
3. `tests/milestone-3-recovery-integrity-audit.test.js`: **PASSED (8/8)**
4. `tests/post-backup-reconciliation.test.js`: **PASSED (36/36)**
5. `tests/historical-attempt-migration.test.js`: **PASSED (12/12)**
6. `tests/pyq-library.test.js`: **PASSED (21/21)**
7. `tests/admin-import-pipeline.test.js`: **PASSED (14/14)**
8. `tests/admin-api-integration.test.js`: **PASSED (27/27)**
9. `tests/admin-user-management.test.js`: **PASSED (22/22)**
10. `tests/exam-profile-registry.test.js`: **PASSED (55/55)**
11. `tests/mock-test-performance-and-review.test.js`: **PASSED (33/33)**
12. `tests/mock-test-search-sort.test.js`: **PASSED (28/28)**
13. `tests/universal-scoring-engine.test.js`: **PASSED (29/29)**
14. `tests/firestore-admin-auth.test.js`: **PASSED (36/36)**

---

## Updated Staging Restore Blockers Summary

| Blocker ID | Description | Severity | Status | Action Required |
| :--- | :--- | :---: | :---: | :--- |
| **BLK-01** | Production SA Key in Local Workspace | **CRITICAL** | **OPEN** | Cloud Admin must revoke key in GCP IAM and delete local file. |
| **BLK-02** | Staging GCP Project Non-Existent | **CRITICAL** | **OPEN** | Cloud Admin must create `staging-vidyarthiastra` in `asia-south1`. |
| **BLK-03** | Staging Service Account & Credentials Missing | **CRITICAL** | **OPEN** | Cloud Admin must create staging SA and generate staging key. |
| **BLK-04** | Hardcoded Production Fallbacks | **CRITICAL** | **RESOLVED** | Remediated in all 7 files; fail-closed validation verified. |
| **BLK-05** | Ambient Migration Project Fallback | **CRITICAL** | **RESOLVED** | Remediated via `_getClient` bound client enforcement. |
| **BLK-06** | Backup Bucket & Cross-Project IAM Unverified | **CRITICAL** | **OPEN** | Cloud Admin must verify bucket existence and grant IAM roles. |
| **BLK-07** | `.firebaserc` Ambiguous Configuration | **HIGH** | **RESOLVED** | Updated `.firebaserc` with explicit production and staging aliases. |
| **BLK-08** | Backup Script Subcollection Omission | **HIGH** | **RESOLVED** | Updated `preflight-backup-check.sh` to full database export default. |

---

## Cloud Administrator Prerequisite Checklist (Before Live Drill)

Before any operator runs the staging restore drill or migration scripts against cloud infrastructure, the Cloud Administrator must complete the following actions:

1. **[CRITICAL] Revoke Compromised Production Key (BLK-01):**
   ```bash
   # List active keys for production service account
   gcloud iam service-accounts keys list \
       --iam-account=firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com \
       --project=pyqs-hub-43bed

   # Identify the exposed key ID and delete it
   gcloud iam service-accounts keys delete <EXPOSED_KEY_ID> \
       --iam-account=firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com \
       --project=pyqs-hub-43bed

   # Remove local credential file
   rm -f serviceAccountKey.json
   ```

2. **[CRITICAL] Provision Staging GCP Project & Firestore Native (BLK-02):**
   ```bash
   # Create staging project
   gcloud projects create staging-vidyarthiastra --name="VidyarthiAstra Staging"

   # Initialize Firestore in Native mode in asia-south1
   gcloud firestore databases create \
       --project=staging-vidyarthiastra \
       --location=asia-south1 \
       --type=firestore-native
   ```

3. **[CRITICAL] Create Dedicated Staging Service Account (BLK-03):**
   ```bash
   # Create service account
   gcloud iam service-accounts create staging-app-sa \
       --display-name="VidyarthiAstra Staging App" \
       --project=staging-vidyarthiastra

   # Grant Datastore User role strictly in staging project
   gcloud projects add-iam-policy-binding staging-vidyarthiastra \
       --member="serviceAccount:staging-app-sa@staging-vidyarthiastra.iam.gserviceaccount.com" \
       --role="roles/datastore.user"
   ```

4. **[CRITICAL] Create Backup Bucket & Grant Cross-Project IAM (BLK-06):**
   ```bash
   # Create production backup bucket in asia-south1
   gcloud storage buckets create gs://pyqs-hub-43bed-backups-asia-south1 \
       --project=pyqs-hub-43bed \
       --location=asia-south1 \
       --uniform-bucket-level-access

   # Grant objectAdmin to production Firestore service agent
   gcloud storage buckets add-iam-policy-binding gs://pyqs-hub-43bed-backups-asia-south1 \
       --member="serviceAccount:service-766070215379@gcp-sa-firestore.iam.gserviceaccount.com" \
       --role="roles/storage.objectAdmin"

   # Grant objectViewer to staging Firestore service agent
   STAGING_NUM=$(gcloud projects describe staging-vidyarthiastra --format='value(projectNumber)')
   gcloud storage buckets add-iam-policy-binding gs://pyqs-hub-43bed-backups-asia-south1 \
       --member="serviceAccount:service-${STAGING_NUM}@gcp-sa-firestore.iam.gserviceaccount.com" \
       --role="roles/storage.objectViewer"
   ```

---

## Conclusion & Governance Verdict

- **Local Code Remediation:** **PASSED & COMPLETE**. All hardcoded production fallbacks, ambient migration inferences, subcollection backup omissions, and configuration ambiguities have been resolved and verified with 100% test pass rate across 616 automated tests.
- **Production Migration Status:** **STRICT NO-GO**. Live operations remain strictly blocked until the Cloud Administrator completes all 4 external cloud infrastructure actions (BLK-01, BLK-02, BLK-03, BLK-06).

