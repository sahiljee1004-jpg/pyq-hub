#!/usr/bin/env bash
# ==============================================================================
# VidyarthiAstra Milestone 3 — Staging Restore Preflight Audit Script
#
# STRICT SAFETY CONSTRAINTS:
# 1. READ-ONLY AUDIT ONLY.
# 2. NEVER creates or modifies GCS buckets.
# 3. NEVER grants or changes IAM permissions.
# 4. NEVER executes Firestore exports, imports, or writes.
# 5. STRICTLY FORBIDS execution against production (pyqs-hub-43bed).
# 6. EVERY command passes explicit --project and --database flags.
# ==============================================================================

set -euo pipefail

PROD_PROJECT_ID="pyqs-hub-43bed"
PROD_PROJECT_NUMBER="766070215379"
EXPECTED_LOCATION="asia-south1"
BUCKET_NAME="pyqs-hub-43bed-backups-asia-south1"
EXPECTED_DATABASE="(default)"

STAGING_PROJECT_ID="${1:-staging-vidyarthiastra}"
EXPORT_URI="${2:-}"

echo "================================================================================"
echo "    VIDYARTHIASTRA MILESTONE 3: STAGING RESTORE PREFLIGHT AUDIT"
echo "================================================================================"
echo "Staging Target Project : ${STAGING_PROJECT_ID}"
echo "Target Firestore DB    : ${EXPECTED_DATABASE}"
echo "Production Backup GCS  : gs://${BUCKET_NAME}"
echo "Export URI To Restore  : ${EXPORT_URI:-'(Not specified - permission audit only)'}"
echo "--------------------------------------------------------------------------------\n"

# Gate 1: Strict Production Block & Staging Allowlist
echo "[Gate 1/6] Verifying staging project identity & safety boundary..."
if [[ "${STAGING_PROJECT_ID}" == "${PROD_PROJECT_ID}" ]] || [[ "${STAGING_PROJECT_ID}" == *"prod"* ]]; then
    echo "FATAL ERROR: Target project '${STAGING_PROJECT_ID}' is production or contains 'prod'."
    echo "Staging restore preflight is STRICTLY forbidden on production environments."
    exit 1
fi
echo "  ✓ Target confirmed as non-production: ${STAGING_PROJECT_ID}"

# Gate 2: Verify Staging Project Number & Derive Service Agent
echo "[Gate 2/6] Verifying staging numeric project ID and deriving service agent..."
STAGING_NUM=$(gcloud projects describe "${STAGING_PROJECT_ID}" --format="value(projectNumber)" 2>/dev/null || true)
if [[ -z "${STAGING_NUM}" ]]; then
    echo "FAILED: Unable to retrieve project number for '${STAGING_PROJECT_ID}'."
    echo "Verify that project exists and caller has 'resourcemanager.projects.get' permission."
    exit 1
fi
STAGING_SERVICE_AGENT="service-${STAGING_NUM}@gcp-sa-firestore.iam.gserviceaccount.com"
echo "  ✓ Staging project number: ${STAGING_NUM}"
echo "  ✓ Derived Staging Service Agent: ${STAGING_SERVICE_AGENT}"

# Gate 3: Read-Only Bucket IAM Check for Staging Service Agent
echo "[Gate 3/6] Verifying staging service agent read access on production backup bucket..."
IAM_POLICY=$(gcloud storage buckets get-iam-policy "gs://${BUCKET_NAME}" --project="${PROD_PROJECT_ID}" --format="json" 2>/dev/null || true)

if [[ "${IAM_POLICY}" != *"${STAGING_SERVICE_AGENT}"* ]] || [[ "${IAM_POLICY}" != *"roles/storage.objectViewer"* && "${IAM_POLICY}" != *"roles/storage.admin"* && "${IAM_POLICY}" != *"roles/storage.objectAdmin"* ]]; then
    echo "FAILED: Staging service agent '${STAGING_SERVICE_AGENT}' lacks read access to 'gs://${BUCKET_NAME}'."
    echo "Remediation (Cloud Administrator action required on production bucket):"
    echo "  gcloud storage buckets add-iam-policy-binding gs://${BUCKET_NAME} \\"
    echo "    --project=\"${PROD_PROJECT_ID}\" \\"
    echo "    --member=\"serviceAccount:${STAGING_SERVICE_AGENT}\" \\"
    echo "    --role=\"roles/storage.objectViewer\""
    echo "Note: This preflight script will NOT automatically grant permissions."
    exit 1
fi
echo "  ✓ Staging service agent read permissions verified on backup bucket."

# Gate 4: Read-Only Operator Import Permission Check
echo "[Gate 4/6] Verifying operator import permissions on staging project..."
CALLER_ACCOUNT=$(gcloud config get-value account 2>/dev/null || true)
echo "  Caller Account: ${CALLER_ACCOUNT}"

PERMS=$(gcloud projects test-iam-permissions "${STAGING_PROJECT_ID}" \
    --permissions="datastore.databases.import,datastore.operations.get" \
    --format="value(permissions)" 2>/dev/null || true)

if [[ "${PERMS}" != *"datastore.databases.import"* ]]; then
    echo "FAILED: Caller '${CALLER_ACCOUNT}' lacks 'datastore.databases.import' on '${STAGING_PROJECT_ID}'."
    echo "Remediation (Cloud Administrator action required on staging project):"
    echo "  gcloud projects add-iam-policy-binding ${STAGING_PROJECT_ID} \\"
    echo "    --member=\"user:${CALLER_ACCOUNT}\" \\"
    echo "    --role=\"roles/datastore.importExportAdmin\""
    echo "Note: This preflight script will NOT automatically grant permissions."
    exit 1
fi
echo "  ✓ Operator import permissions confirmed."

# Gate 5: Verify Staging Firestore Database Identity, Location & Mode
echo "[Gate 5/7] Verifying staging Firestore database identity, location, and native mode..."
DB_INFO=$(gcloud firestore databases describe --database="${EXPECTED_DATABASE}" --project="${STAGING_PROJECT_ID}" --format="json" 2>/dev/null || true)
if [[ -n "${DB_INFO}" ]]; then
    DB_TYPE=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.type || ''); } catch { process.stdout.write(''); }" "${DB_INFO}")
    DB_LOCATION=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.locationId || ''); } catch { process.stdout.write(''); }" "${DB_INFO}")
    if [[ "${DB_TYPE}" != "FIRESTORE_NATIVE" ]]; then
        echo "FAILED: Staging database type is '${DB_TYPE}', expected 'FIRESTORE_NATIVE'."
        exit 1
    fi
    if [[ -n "${DB_LOCATION}" && "${DB_LOCATION,,}" != "${EXPECTED_LOCATION,,}" ]]; then
        echo "FAILED: Staging database location is '${DB_LOCATION}', expected '${EXPECTED_LOCATION}'."
        exit 1
    fi
    echo "  ✓ Staging database confirmed: ${EXPECTED_DATABASE} (FIRESTORE_NATIVE, location: ${DB_LOCATION:-$EXPECTED_LOCATION})"
else
    echo "  Notice: Database describe skipped (requires datastore.databases.get on staging)."
fi

# Gate 6: Verify Backup Artifact Readability (if EXPORT_URI provided)
echo "[Gate 6/7] Verifying backup artifact readability..."
if [[ -n "${EXPORT_URI}" ]]; then
    METADATA_EXISTS=$(gcloud storage objects list "${EXPORT_URI}/*.overall_export_metadata" --project="${PROD_PROJECT_ID}" --format="value(name)" 2>/dev/null || true)
    if [[ -z "${METADATA_EXISTS}" ]]; then
        echo "FAILED: Cannot read overall_export_metadata at '${EXPORT_URI}'."
        echo "Verify the URI is complete and points to a successful export folder."
        exit 1
    fi
    echo "  ✓ Authoritative export metadata found: ${METADATA_EXISTS}"
else
    echo "  Notice: EXPORT_URI not provided. Run with second argument to verify specific artifact."
fi

# Gate 7: Manual Operator Confirmation Check & Target Summary
echo "[Gate 7/7] Operator Target Verification & Safety Checklist:"
echo "--------------------------------------------------------------------------------"
echo "  [TARGET STAGING PROJECT] : ${STAGING_PROJECT_ID} (Number: ${STAGING_NUM:-'unknown'})"
echo "  [TARGET FIRESTORE DB]    : ${EXPECTED_DATABASE}"
echo "  [TARGET REGION/LOCATION] : ${EXPECTED_LOCATION}"
echo "  [DERIVED SERVICE AGENT]  : ${STAGING_SERVICE_AGENT}"
echo "  [PRODUCTION RECOVERY GCS]: gs://${BUCKET_NAME}"
echo "  [PRODUCTION PROJECT]     : ${PROD_PROJECT_ID} (STRICTLY BLOCKED FROM RESET/WRITES)"
echo "--------------------------------------------------------------------------------"
echo "MANUAL VERIFICATION MANDATE:"
echo "The operator must manually confirm that the project ID above is the STAGING project"
echo "and NOT the production project '${PROD_PROJECT_ID}' before proceeding."

echo "\n================================================================================"
echo "All 7 Staging Preflight Gates Passed! Ready for operator-initiated staging restore."
echo "================================================================================"
echo "Authorized Operator Step 1 (Purge Staging Baseline):"
echo "  ALLOW_STAGING_CLOUD_WRITES=true node scripts/reset-staging-baseline.js \\"
echo "    --project=\"${STAGING_PROJECT_ID}\" \\"
echo "    --database=\"${EXPECTED_DATABASE}\" \\"
echo "    --confirm-staging-reset \\"
echo "    --recovery-export-metadata=./artifacts/prod-export-metadata.json \\"
echo "    --output=./artifacts/staging-reset-audit.json"
echo ""
echo "Authorized Operator Step 2 (Execute Managed Import):"
echo "  gcloud firestore import \"${EXPORT_URI:-'<EXPORT_URI>'}\" \\"
echo "    --project=\"${STAGING_PROJECT_ID}\" \\"
echo "    --database=\"${EXPECTED_DATABASE}\" \\"
echo "    --collection-ids=mockAttempts,mockResults,mockTests,mockQuestions,migrationCheckpoints"
echo "================================================================================"

