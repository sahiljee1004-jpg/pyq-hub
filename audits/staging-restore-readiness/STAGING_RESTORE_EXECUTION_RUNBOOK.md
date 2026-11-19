# Milestone 3 — Staging Restore Execution Runbook

> [!CAUTION]
> **DO NOT EXECUTE THIS RUNBOOK DURING AUDIT SESSIONS**  
> This document defines the standard operating procedure for a future, authorized staging drill. No commands in this runbook may be run without explicit stakeholder approval, confirmed key revocation, dedicated staging credentials, and formal change authorization.

---

## 1. Overview & Objectives

The purpose of this drill is to prove, in an isolated staging Google Cloud environment, that:
1. An authoritative managed export (`gcloud firestore export`) of production Firestore collections can be created and cryptographically verified.
2. An isolated staging database can be purged cleanly and restored via `gcloud firestore import`.
3. 100% of documents across the 5 migrated collections (`mockAttempts`, `mockResults`, `mockTests`, `mockQuestions`, `migrationCheckpoints`) are restored without data loss or corruption.
4. Historical attempt scores, question-level marks, and answers are preserved verbatim without recalculation.
5. In the event of post-backup student activity, `reconcile-post-backup.js` correctly reconciles and reapplies modifications under strict Firestore `updateTime` preconditions.
6. The entire workflow can be executed without using production credentials on staging or exposing sensitive keys.

---

## 2. Operator Roles & Required Approvals

| Role | Responsibilities | Assigned Individual | Sign-off Required |
| :--- | :--- | :--- | :---: |
| **Cloud Administrator** | GCP project setup, IAM permissions, bucket management, key revocation confirmation | *Authorized Cloud Admin* | **YES** |
| **Lead Architect** | Code validation, schema verification, arithmetic precision audit | *Senior System Architect* | **YES** |
| **Authorized Operator** | Script execution, artifact hashing, log capture, verification assertion | *Designated Operations Engineer* | **YES** |
| **Quality Auditor** | Independent verification of outputs, checksum assertions, post-drill review | *QA/Security Auditor* | **YES** |

---

## 3. Step-by-Step Procedure

### Phase 0: Pre-Drill Infrastructure Validation

1. **Verify Production Key Revocation:**
   Cloud Administrator confirms in GCP IAM Console that service account key for `firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com` originally stored at `serviceAccountKey.json` is revoked or replaced.
   ```bash
   # Administrator verifies key status
   gcloud iam service-accounts keys list \
     --iam-account=firebase-adminsdk-fbsvc@pyqs-hub-43bed.iam.gserviceaccount.com \
     --project=pyqs-hub-43bed
   ```
2. **Verify Staging Project Environment:**
   ```bash
   gcloud config set project staging-vidyarthiastra
   gcloud firestore databases describe --database="(default)" --project=staging-vidyarthiastra
   ```
3. **Verify Staging Service Account & Export Read IAM:**
   Ensure staging Firestore service agent has read access on production backup bucket:
   ```bash
   STAGING_NUM=$(gcloud projects describe staging-vidyarthiastra --format="value(projectNumber)")
   gcloud storage buckets get-iam-policy gs://pyqs-hub-43bed-backups-asia-south1 \
     --project=pyqs-hub-43bed \
     --format="json" | grep "service-${STAGING_NUM}@gcp-sa-firestore.iam.gserviceaccount.com"
   ```

---

### Phase 1: Production Maintenance Mode & Pre-Export Snapshot

1. **Activate Production Maintenance Mode:**
   Disable student submissions and background batch writes on production to freeze state:
   ```bash
   # Set maintenance banner and freeze client writes
   # Verify that active attempt count is stable
   ```
2. **Capture Production Pre-Export Baseline Counts:**
   ```bash
   node scripts/generate-pre-export-counts.js \
     --project=pyqs-hub-43bed \
     --database="(default)" \
     --output=./artifacts/prod-pre-export-counts.json
   
   # Generate cryptographic checksum
   sha256sum ./artifacts/prod-pre-export-counts.json > ./artifacts/prod-pre-export-counts.json.sha256
   ```

---

### Phase 2: Production Managed Cold Export

1. **Run Production Backup Preflight Audit:**
   ```bash
   bash scripts/preflight-backup-check.sh
   ```
   *Expected Outcome:* Gates 1 through 6 pass; cold export initiates to `gs://pyqs-hub-43bed-backups-asia-south1/pre-migration-TIMESTAMP`.
2. **Wait for Managed Export Completion:**
   `scripts/preflight-backup-check.sh` polls until `done: true` and saves output to `./artifacts/export-operation-metadata.json`.
3. **Record Export Provenance URI:**
   Extract `outputUriPrefix` from `./artifacts/export-operation-metadata.json`:
   ```bash
   EXPORT_URI=$(node -e "const d = require('./artifacts/export-operation-metadata.json'); console.log(d.response?.outputUriPrefix || d.metadata?.outputUriPrefix);")
   echo "Authoritative Export URI: ${EXPORT_URI}"
   ```

---

### Phase 3: Staging Environment Isolation & Baseline Purge

1. **Switch Active Context to Staging Project:**
   ```bash
   gcloud config set project staging-vidyarthiastra
   export FIREBASE_PROJECT_ID="staging-vidyarthiastra"
   export GOOGLE_CLOUD_PROJECT="staging-vidyarthiastra"
   ```
2. **Execute Preflight Staging Import Check:**
   ```bash
   bash scripts/preflight-staging-import-check.sh "staging-vidyarthiastra" "${EXPORT_URI}"
   ```
   *Expected Outcome:* All 7 gates pass.
3. **Execute Staging Baseline Reset:**
   ```bash
   ALLOW_STAGING_CLOUD_WRITES=true node scripts/reset-staging-baseline.js \
     --project=staging-vidyarthiastra \
     --database="(default)" \
     --confirm-staging-reset \
     --recovery-export-metadata=./artifacts/export-operation-metadata.json \
     --output=./artifacts/staging-reset-audit.json
   ```
   *Expected Outcome:*
   - Proves `export-operation-metadata.json` is successful and from `pyqs-hub-43bed`.
   - Purges all 5 collections and recursive subcollections.
   - Asserts 100% emptiness across all collections and descendant paths (`COMPLETED_CLEAN`).
   - Generates `./artifacts/staging-reset-audit.json.sha256`.

---

### Phase 4: Staging Managed Restore (`gcloud firestore import`)

1. **Execute Managed Import Command:**
   ```bash
   gcloud firestore import "${EXPORT_URI}" \
     --project=staging-vidyarthiastra \
     --database="(default)" \
     --collection-ids=mockAttempts,mockResults,mockTests,mockQuestions,migrationCheckpoints
   ```
2. **Monitor Operation Until Completion:**
   ```bash
   # Retrieve operation ID from output and poll:
   gcloud firestore operations describe <OPERATION_NAME> \
     --project=staging-vidyarthiastra \
     --database="(default)"
   ```
   Confirm `"done": true` and `"error"` is absent.

---

### Phase 5: Post-Restore Verification & Parity Audit

1. **Extract Staging Post-Restore Snapshot:**
   ```bash
   node scripts/export-pre-migration-snapshot.js \
     --project=staging-vidyarthiastra \
     --export-uri="${EXPORT_URI}" \
     --export-metadata=./artifacts/export-operation-metadata.json \
     --output=./artifacts/staging-restored-snapshot.json \
     --strict-counts
   ```
2. **Compare Collection Counts:**
   Verify restored counts match pre-export baseline:
   ```bash
   node -e "
     const pre = require('./artifacts/prod-pre-export-counts.json').counts;
     const post = require('./artifacts/staging-restored-snapshot.json').counts;
     console.log('Pre-Export vs Restored Parity:');
     for (const k of Object.keys(pre)) {
       const match = pre[k] === post[k];
       console.log(' ', k.padEnd(25), 'Pre:', pre[k], 'Post:', post[k], match ? '✓ MATCH' : '✗ MISMATCH');
       if (!match) process.exit(1);
     }
     console.log('100% Document Count Parity Verified.');
   "
   ```
3. **Verify Historical Attempt/Result Integrity:**
   Verify that all attempts link to results and scores match breakdowns:
   ```bash
   node -e "
     const snap = require('./artifacts/staging-restored-snapshot.json');
     const attempts = snap.attempts;
     const results = snap.results;
     console.log('Verifying attempt-to-result integrity for', attempts.length, 'attempts...');
     const resMap = new Map(results.map(r => [r.attemptId, r]));
     let verified = 0;
     for (const a of attempts) {
       if (a.status === 'submitted' || a.status === 'completed') {
         const r = resMap.get(a.attemptId);
         if (!r) throw new Error('Missing result for attempt: ' + a.attemptId);
         if (typeof r.totalScore !== 'number') throw new Error('Invalid score for result: ' + r.resultId);
         verified++;
       }
     }
     console.log('✓ Successfully verified integrity of', verified, 'submitted attempts and results.');
   "
   ```

---

### Phase 6: Post-Backup Reconciliation Simulation (Optional Edge Case Verification)

1. **Simulate Concurrent Modifications:**
   If testing state reconciliation, seed 1 synthetic post-backup attempt into staging.
2. **Generate Reconciliation Manifest:**
   ```bash
   node scripts/reconcile-post-backup.js \
     --project=staging-vidyarthiastra \
     --backup-file=./artifacts/staging-restored-snapshot.json \
     --manifest-output=./artifacts/reconciliation-manifest.json \
     --dry-run
   ```
3. **Verify Reapplication Preconditions:**
   Confirm that existing documents match preconditions and new documents are flagged as `PRESERVE_NEW_DOCUMENT`.

---

### Phase 7: Rollback & Failure Recovery Procedures

1. **If Managed Import Fails:**
   - Staging database remains in staging; production is completely unaffected.
   - Run `reset-staging-baseline.js` to re-purge staging.
   - Inspect GCP Cloud Logging for the failed import operation.
2. **If Verification Counts Discrepant:**
   - Investigate whether maintenance mode was breached during backup.
   - Compare document IDs between pre-export list and restored snapshot.
   - Staging drill is marked **FAILED**; production migration remains **STRICT NO-GO**.

---

### Phase 8: Final Evidence Archival & Sign-Off

Capture all audit artifacts into `audits/staging-restore-readiness/evidence/`:
1. `export-operation-metadata.json` & `.sha256`
2. `prod-pre-export-counts.json` & `.sha256`
3. `staging-reset-audit.json` & `.sha256`
4. `staging-restored-snapshot.json` & `.sha256`
5. Shell execution logs with exact terminal outputs and timestamps.
6. Formal signature from Operator, Lead Architect, and Cloud Administrator.

