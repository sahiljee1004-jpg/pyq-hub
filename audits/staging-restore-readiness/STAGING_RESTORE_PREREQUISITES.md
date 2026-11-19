# Milestone 3 — Staging Restore Prerequisites Checklist

**Audit Date:** 2026-11-14T01:16:00+05:30  
**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Purpose:** Actionable checklist of mandatory prerequisites required before executing an authorized staging restore drill.

---

## 1. Prerequisites Checklist & Status Matrix

| Category | Prerequisite Item | Status | Verification Criteria & Required Evidence | Responsible Role |
| :--- | :--- | :---: | :--- | :--- |
| **GCP Project** | 1.1 Create Isolated Staging Project | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | A dedicated GCP project (e.g. `staging-vidyarthiastra`) must exist in GCP, distinct from `pyqs-hub-43bed`. Output of `gcloud projects describe staging-vidyarthiastra` must show active status. | Cloud Administrator |
| **GCP Project** | 1.2 Enable Firestore Native Mode in `asia-south1` | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Firestore database `(default)` in the staging project must be initialized in `FIRESTORE_NATIVE` mode in location `asia-south1`. | Cloud Administrator |
| **GCP Project** | 1.3 Add Staging Alias in `.firebaserc` | **PENDING** | `.firebaserc` must define `"staging": "staging-vidyarthiastra"` so CLI tools do not default to production `pyqs-hub-43bed`. | Developer |
| **Credentials** | 2.1 Revoke/Rotate Exposed Production Service Account Key | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Confirmation from GCP IAM console that key ID corresponding to `serviceAccountKey.json` (`firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com`) is deleted/disabled. | Cloud Administrator |
| **Credentials** | 2.2 Remove `serviceAccountKey.json` from Local Workspace | **PENDING** | Once rotated/revoked, the physical file `serviceAccountKey.json` must be safely archived and removed from the active working directory. | Operator |
| **Credentials** | 2.3 Create Dedicated Staging Service Account | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Service account (e.g. `staging-app-sa@staging-vidyarthiastra.iam.gserviceaccount.com`) created in staging project with zero permissions in production. | Cloud Administrator |
| **Credentials** | 2.4 Configure Staging Credentials via Environment Variables | **PENDING** | `FIREBASE_SERVICE_ACCOUNT` or `GOOGLE_APPLICATION_CREDENTIALS` configured pointing exclusively to staging credentials. | Operator |
| **IAM Policy** | 3.1 Grant Storage Admin to Production Firestore Service Agent | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | `service-766070215379@gcp-sa-firestore.iam.gserviceaccount.com` has `roles/storage.objectAdmin` on `gs://pyqs-hub-43bed-backups-asia-south1`. | Cloud Administrator |
| **IAM Policy** | 3.2 Grant Storage Viewer to Staging Firestore Service Agent | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Derived staging agent `service-<STAGING_NUM>@gcp-sa-firestore.iam.gserviceaccount.com` has `roles/storage.objectViewer` on `gs://pyqs-hub-43bed-backups-asia-south1`. | Cloud Administrator |
| **IAM Policy** | 3.3 Grant Datastore Import/Export to Operator | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Authorized human operator has `roles/datastore.importExportAdmin` in staging project and production export permission. | Cloud Administrator |
| **IAM Policy** | 3.4 Restrict Staging Application Service Account | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Staging runtime service account granted ONLY `roles/datastore.user` on staging project; zero access to production bucket or production project. | Cloud Administrator |
| **GCS Bucket** | 4.1 Provision Production Backup Bucket | **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR** | Bucket `gs://pyqs-hub-43bed-backups-asia-south1` created in `asia-south1` with uniform bucket-level access and retention policy. | Cloud Administrator |
| **Code Safety** | 5.1 Remove Hardcoded Production Defaults in Application Routes | **BLOCKED** | Hardcoded `|| "pyqs-hub-43bed"` in `papers.js`, `studyResources.js`, `pyqLibraryService.js`, `questionExtractionService.js`, `paperSearchService.js`, and `adminAuthService.js` must be replaced with mandatory project injection. | Developer |
| **Code Safety** | 5.2 Remove Ambient Project Fallback in Migration Service | **BLOCKED** | `HistoricalAttemptMigrationService` lines 474, 597, 719 must reject execution if neither `client` nor `targetProjectId` is provided. | Developer |
| **Backup** | 6.1 Execute Controlled Cold Export of Production Data | **PENDING** | Preflight check `scripts/preflight-backup-check.sh` must execute in production maintenance mode to create an authoritative export. | Operator |
| **Backup** | 6.2 Capture Authoritative Export Operation Metadata | **PENDING** | Export operation output (`./artifacts/export-operation-metadata.json`) containing `outputUriPrefix` and progress document counts. | Operator |
| **Backup** | 6.3 Generate Companion SHA-256 Checksums | **PENDING** | SHA-256 checksums generated for export metadata and baseline documents. | Operator |
| **Staging Reset** | 7.1 Verify Production Recovery Proof Before Purging Staging | **COMPLETE (CODE ONLY)** | `scripts/reset-staging-baseline.js` (Gate 7) enforces successful `pyqs-hub-43bed` recovery export metadata before purging staging. | Verified in code & test |
| **Staging Reset** | 7.2 Execute Staging Database Baseline Purge | **PENDING** | Purge staging collections and recursive subcollections; assert 100% emptiness (`executionOutcome: COMPLETED_CLEAN`). | Operator |
| **Restore** | 8.1 Execute Managed Staging Import (`gcloud firestore import`) | **PENDING** | Import executed targeting staging project and verified output URI prefix. | Operator |
| **Verification** | 9.1 Post-Restore Document Count Parity Check | **COMPLETE (TOOL READY)** | `scripts/export-pre-migration-snapshot.js` ready to extract and verify document count parity against export metadata. | Tool verified in emulator |
| **Verification** | 9.2 Post-Backup State Reconciliation Reapplication | **COMPLETE (TOOL READY)** | `scripts/reconcile-post-backup.js` ready to classify and reapply post-backup additions with Firestore updateTime preconditions. | Tool verified in emulator |
| **Sign-Off** | 10.1 Operator and Architect Sign-Off Form | **PENDING** | Written approval from Cloud Administrator, Senior Architect, and Operator verifying all stages. | All Stakeholders |

---

## 2. Summary Status Counts

- **COMPLETE (VERIFIED FROM EVIDENCE):** 3 (Utility code & verification tools ready)
- **PENDING:** 7 (Awaiting operational execution steps)
- **NOT VERIFIED — REQUIRES AUTHORIZED OPERATOR:** 10 (GCP IAM, cloud buckets, and credentials)
- **BLOCKED:** 2 (Code-level ambient fallback defects must be resolved)

