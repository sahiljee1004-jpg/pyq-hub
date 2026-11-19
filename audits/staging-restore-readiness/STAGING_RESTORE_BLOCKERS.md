# Milestone 3 — Staging Restore Blockers Register

**Audit Date:** 2026-11-14T01:17:00+05:30  
**Last Updated:** 2026-11-14T02:00:00+05:30  
**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Purpose:** Formal log of every identified technical, architectural, credential, and cloud blocker preventing execution of the live staging restore drill.

---

## 1. Summary of Blockers & Status

| Blocker ID | Severity | Category | Location | Responsible Role | Status | Resolution / Verification |
| :--- | :---: | :--- | :--- | :---: | :---: | :--- |
| **BLK-01** | **CRITICAL** | Credential Security | Local / Cloud IAM | Cloud Administrator | **OPEN** | Requires Cloud Admin to revoke/rotate key and purge from host. |
| **BLK-02** | **CRITICAL** | Cloud Infrastructure | GCP Cloud Console | Cloud Administrator | **OPEN** | Requires Cloud Admin provisioning in `asia-south1`. |
| **BLK-03** | **CRITICAL** | Credential Security | GCP Cloud IAM | Cloud Administrator | **OPEN** | Requires dedicated staging SA credential creation. |
| **BLK-04** | **CRITICAL** | Code Architecture | `server/routes/`, `server/services/` | Developer | **RESOLVED** | Removed all hardcoded `|| "pyqs-hub-43bed"` fallbacks; enforced fail-closed validation. |
| **BLK-05** | **CRITICAL** | Code Architecture | `historicalAttemptMigrationService.js` | Developer | **RESOLVED** | Removed ambient `FIREBASE_PROJECT_ID` inference; enforced bound client / explicit target. |
| **BLK-06** | **CRITICAL** | Cloud Storage & IAM | GCP Cloud Console | Cloud Administrator | **OPEN** | Requires bucket existence & cross-project IAM grants in GCP. |
| **BLK-07** | **HIGH** | Configuration | `.firebaserc` | Developer | **RESOLVED** | Added explicit `"production"` and `"staging"` targets; documented default alias behavior. |
| **BLK-08** | **HIGH** | Backup Completeness | `scripts/preflight-backup-check.sh` | Developer | **RESOLVED** | Removed collection filtering default to back up entire database preserving all subcollections. |

---

## 2. Detailed Blocker Analysis & Resolution Details

---

### BLK-01: Unconfirmed Production Service Account Key Revocation & Rotation

- **Description:** A production GCP service account private key (`serviceAccountKey.json`) corresponding to `firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com` remains present in the local workspace directory.
- **Why It Matters:** If this key was exposed or unrevoked, production Firestore and storage could be compromised. Performing staging drills while an active production credential sits in the working environment creates an unacceptable cross-contamination and exfiltration risk.
- **Evidence Required to Close:**
  1. Cloud Administrator executes `gcloud iam service-accounts keys list` and confirms the key ID matching the local file is disabled or deleted.
  2. A new, strictly scoped key is rotated if needed, and `serviceAccountKey.json` is permanently removed from the active workspace.
- **Responsible Role:** Cloud Administrator (Primary) / Operator (Local cleanup).
- **Resolution Domain:** **Requires Authorized Cloud Access** (GCP IAM Console / CLI).
- **Status:** **OPEN** (Cloud Administrator action pending).

---

### BLK-02: Non-Existent or Unconfirmed Staging GCP Project

- **Description:** The staging project identifier `staging-vidyarthiastra` is referenced in script comments and allowlists, but no evidence exists that this project has been created, initialized, or configured in Google Cloud Platform.
- **Why It Matters:** A managed staging restore drill cannot execute without an actual, isolated GCP project with Firestore in Native Mode in `asia-south1`.
- **Evidence Required to Close:**
  1. Terminal output of `gcloud projects describe staging-vidyarthiastra` showing `lifecycleState: ACTIVE`.
  2. Terminal output of `gcloud firestore databases describe --project=staging-vidyarthiastra --database="(default)"` showing `type: FIRESTORE_NATIVE` and `locationId: asia-south1`.
- **Responsible Role:** Cloud Administrator.
- **Resolution Domain:** **Requires Authorized Cloud Access** (GCP Cloud Console / CLI).
- **Status:** **OPEN** (Cloud Administrator action pending).

---

### BLK-03: Missing Dedicated Staging Service Account & Credentials

- **Description:** No staging-specific service account or credential file exists in the repository, `.env`, or local filesystem.
- **Why It Matters:** If an operator attempts to run the staging server or staging scripts without staging credentials, the code may fail or attempt to authenticate using ambient production credentials. Staging must operate with dedicated, least-privilege credentials that have zero access to production.
- **Evidence Required to Close:**
  1. A dedicated staging service account (`staging-app-sa@staging-vidyarthiastra.iam.gserviceaccount.com`) created in the staging project.
  2. Key securely provided via `FIREBASE_SERVICE_ACCOUNT` or `GOOGLE_APPLICATION_CREDENTIALS` in the staging environment.
  3. Verification that this credential is rejected if passed to production targets.
- **Responsible Role:** Cloud Administrator.
- **Resolution Domain:** **Requires Authorized Cloud Access**.
- **Status:** **OPEN** (Cloud Administrator action pending).

---

### BLK-04: Hardcoded Production Fallbacks in Core Application Routes & Services

- **Description:** Several application routes and services defaulted to `"pyqs-hub-43bed"` if `process.env.FIREBASE_PROJECT_ID` was not explicitly set:
  - `server/routes/papers.js`
  - `server/routes/studyResources.js`
  - `server/services/pyqLibraryService.js`
  - `server/services/questionExtractionService.js`
  - `server/services/paperSearchService.js`
  - `server/services/admin/adminAuthService.js`
  - `server/routes/admin.js`
- **Resolution Details:**
  - Removed every occurrence of `|| "pyqs-hub-43bed"` and `?? "pyqs-hub-43bed"`.
  - Implemented `getActiveProjectId()` helpers calling `validateProjectIdFormat`.
  - Configured services and routes to fail closed with clear 503 / 500 status codes when `FIREBASE_PROJECT_ID` is unconfigured, whitespace, or invalid.
  - Replaced static `UniversalFirestoreService` calls in administrative routes with bound client `req.adminClient = UniversalFirestoreService.forProject(targetProject)`.
  - Added 5 regression tests in `tests/test-auth-isolation.test.js` validating fail-closed behavior for each service.
- **Status:** **RESOLVED** (Verified by 30/30 tests in `test-auth-isolation.test.js` and 616/616 total workspace tests).

---

### BLK-05: Ambient Project Fallback in `HistoricalAttemptMigrationService`

- **Description:** `HistoricalAttemptMigrationService` previously allowed ambient fallback to `process.env.FIREBASE_PROJECT_ID` when neither `client` nor `targetProjectId` was supplied.
- **Resolution Details:**
  - Added centralized `_getClient({ client, targetProjectId, hasInMemoryDataset, operationName })`.
  - Mandated explicit `UniversalFirestoreClient` instance or validated `targetProjectId`.
  - Strictly rejected ambient `process.env.FIREBASE_PROJECT_ID` fallback for live database execution.
  - Rejected any client not instantiated as `UniversalFirestoreClient`.
  - Rejected conflicting `client.projectId` and `targetProjectId`.
  - Ensured all chunk commits, intermediate checkpoints, and final updates in `executeBatchMigration` reuse `firestoreClient` directly with zero static service fallback.
  - Added 5 regression tests in `tests/test-auth-isolation.test.js` validating client validation and checkpoint preservation.
- **Status:** **RESOLVED** (Verified by 30/30 tests in `test-auth-isolation.test.js` and 12/12 in `historical-attempt-migration.test.js`).

---

### BLK-06: Unverified Backup Bucket & Cross-Project Service Agent IAM

- **Description:** Production backup bucket `gs://pyqs-hub-43bed-backups-asia-south1` has not been proven to exist. Furthermore, cross-project read permissions on this bucket for the staging Firestore service agent (`service-<STAGING_NUM>@gcp-sa-firestore.iam.gserviceaccount.com`) have not been granted.
- **Why It Matters:** `gcloud firestore export` will fail if the bucket does not exist or lacks production service agent permissions (`roles/storage.objectAdmin`). Subsequently, `gcloud firestore import` in the staging project will fail with `PERMISSION_DENIED` when attempting to read the export objects from the production bucket.
- **Evidence Required to Close:**
  1. Terminal output of `gcloud storage buckets describe gs://pyqs-hub-43bed-backups-asia-south1` showing location `asia-south1`.
  2. IAM policy output showing `roles/storage.objectAdmin` bound to `service-766070215379@gcp-sa-firestore.iam.gserviceaccount.com`.
  3. IAM policy output showing `roles/storage.objectViewer` bound to `service-<STAGING_NUM>@gcp-sa-firestore.iam.gserviceaccount.com`.
- **Responsible Role:** Cloud Administrator.
- **Resolution Domain:** **Requires Authorized Cloud Access**.
- **Status:** **OPEN** (Cloud Administrator action pending).

---

### BLK-07: Incomplete Firebase CLI Project Configuration (`.firebaserc`)

- **Description:** `.firebaserc` defined only `"default": "pyqs-hub-43bed"`.
- **Resolution Details:**
  - Added explicit `"production": "pyqs-hub-43bed"` and `"staging": "pyqs-hub-staging"` aliases.
  - Retained `"default": "pyqs-hub-43bed"` to prevent breaking existing production tooling while enabling explicit target deployment via `firebase use staging` or `firebase use production`.
- **Status:** **RESOLVED** (Verified configuration syntax and project mappings).

---

### BLK-08: Subcollection Omission in Managed Export Specification

- **Description:** `scripts/preflight-backup-check.sh` previously specified `--collection-ids=mockAttempts,mockResults,mockTests,mockQuestions,migrationCheckpoints`, omitting nested subcollections such as `sections` under `mockTests`.
- **Resolution Details:**
  - Updated `scripts/preflight-backup-check.sh` to default to whole-database export (omitting `--collection-ids`), ensuring that all top-level collections and nested subcollections are captured in full fidelity.
  - Added support for optional collection-specific export via `EXPORT_COLLECTION_IDS` environment variable when specifically required.
- **Status:** **RESOLVED** (Verified script syntax and default argument resolution).
