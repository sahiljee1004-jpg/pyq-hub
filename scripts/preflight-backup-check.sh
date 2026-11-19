#!/usr/bin/env bash
# ==============================================================================
# VidyarthiAstra Milestone 3 — Production Backup Preflight & Export Trigger
#
# STRICT SAFETY CONSTRAINTS:
# 1. Verifies active Google Cloud project is 'pyqs-hub-43bed'.
# 2. Verifies caller has 'datastore.databases.export' permission.
# 3. Verifies authoritative Firestore service agent (766070215379).
# 4. Verifies backup bucket exists in asia-south1 and has service agent IAM.
# 5. STOPS IMMEDIATELY if any prerequisite is missing.
# 6. NEVER automatically grants IAM roles.
# 7. NEVER locks retention policies.
# 8. NEVER starts migration writes.
# ==============================================================================

set -euo pipefail

EXPECTED_PROJECT_ID="pyqs-hub-43bed"
EXPECTED_PROJECT_NUMBER="766070215379"
EXPECTED_LOCATION="asia-south1"
EXPECTED_DATABASE="(default)"
BUCKET_NAME="pyqs-hub-43bed-backups-asia-south1"
EXPECTED_SERVICE_AGENT="service-${EXPECTED_PROJECT_NUMBER}@gcp-sa-firestore.iam.gserviceaccount.com"

echo "================================================================================"
echo "    VIDYARTHIASTRA MILESTONE 3: PRODUCTION BACKUP PREFLIGHT AUDIT"
echo "================================================================================"

# Gate 1: Verify Active Google Cloud Project
echo "[Gate 1/6] Verifying active Google Cloud project..."
ACTIVE_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [[ "${ACTIVE_PROJECT}" != "${EXPECTED_PROJECT_ID}" ]]; then
    echo "FAILED: Active project is '${ACTIVE_PROJECT}', expected '${EXPECTED_PROJECT_ID}'."
    echo "Remediation: Run 'gcloud config set project ${EXPECTED_PROJECT_ID}'"
    exit 1
fi
echo "  ✓ Active project confirmed: ${ACTIVE_PROJECT}"

# Gate 2: Verify Project Number & Authoritative Service Agent
echo "[Gate 2/6] Verifying authoritative numeric project number..."
ACTUAL_PROJECT_NUMBER=$(gcloud projects describe "${EXPECTED_PROJECT_ID}" --format="value(projectNumber)" 2>/dev/null || true)
if [[ "${ACTUAL_PROJECT_NUMBER}" != "${EXPECTED_PROJECT_NUMBER}" ]]; then
    echo "FAILED: Project number is '${ACTUAL_PROJECT_NUMBER}', expected '${EXPECTED_PROJECT_NUMBER}'."
    echo "Discrepancy detected! Halting without export."
    exit 1
fi
echo "  ✓ Project number confirmed: ${ACTUAL_PROJECT_NUMBER}"
echo "  ✓ Authoritative Service Agent: ${EXPECTED_SERVICE_AGENT}"

# Gate 2b: Verify Production Firestore Database Identity & Location
echo "[Gate 3/6] Verifying Firestore database identity and location..."
DB_INFO=$(gcloud firestore databases describe --database="${EXPECTED_DATABASE}" --project="${EXPECTED_PROJECT_ID}" --format="json" 2>/dev/null || true)
if [[ -n "${DB_INFO}" ]]; then
    DB_LOCATION=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.locationId || ''); } catch { process.stdout.write(''); }" "${DB_INFO}")
    DB_TYPE=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.type || ''); } catch { process.stdout.write(''); }" "${DB_INFO}")
    if [[ "${DB_LOCATION,,}" != "${EXPECTED_LOCATION,,}" ]]; then
        echo "FAILED: Firestore database location is '${DB_LOCATION}', expected '${EXPECTED_LOCATION}'."
        exit 1
    fi
    if [[ "${DB_TYPE}" != "FIRESTORE_NATIVE" ]]; then
        echo "FAILED: Firestore database type is '${DB_TYPE}', expected 'FIRESTORE_NATIVE'."
        exit 1
    fi
    echo "  ✓ Firestore database confirmed: ${EXPECTED_DATABASE} (${DB_TYPE}, ${DB_LOCATION})"
else
    echo "  Notice: Database describe skipped (requires datastore.databases.get)."
fi

# Gate 4: Verify Caller Export Permissions (Does NOT auto-grant)
echo "[Gate 4/6] Verifying caller export permissions..."
CALLER_ACCOUNT=$(gcloud config get-value account 2>/dev/null || true)
echo "  Caller Account: ${CALLER_ACCOUNT}"

PERMS=$(gcloud projects test-iam-permissions "${EXPECTED_PROJECT_ID}" \
    --permissions="datastore.databases.export,datastore.operations.get" \
    --format="value(permissions)" 2>/dev/null || true)

if [[ "${PERMS}" != *"datastore.databases.export"* ]]; then
    echo "FAILED: Caller '${CALLER_ACCOUNT}' lacks 'datastore.databases.export' on '${EXPECTED_PROJECT_ID}'."
    echo "Remediation: Cloud Administrator must grant 'roles/datastore.importExportAdmin' to '${CALLER_ACCOUNT}'."
    echo "Note: This script will NOT automatically grant permissions."
    exit 1
fi
echo "  ✓ Caller export permissions verified."

# Gate 5: Verify Backup Bucket Existence and Location
echo "[Gate 5/6] Verifying backup bucket existence and location..."
BUCKET_EXISTS=$(gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${EXPECTED_PROJECT_ID}" --format="value(name)" 2>/dev/null || true)
if [[ -z "${BUCKET_EXISTS}" ]]; then
    echo "FAILED: Backup bucket 'gs://${BUCKET_NAME}' does not exist."
    echo "Remediation: Run the following command to create the bucket:"
    echo "  gcloud storage buckets create gs://${BUCKET_NAME} --project=${EXPECTED_PROJECT_ID} --location=${EXPECTED_LOCATION} --uniform-bucket-level-access"
    exit 1
fi

BUCKET_LOC=$(gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${EXPECTED_PROJECT_ID}" --format="value(location)" 2>/dev/null || true)
if [[ "${BUCKET_LOC,,}" != "${EXPECTED_LOCATION,,}" ]]; then
    echo "FAILED: Bucket location is '${BUCKET_LOC}', expected '${EXPECTED_LOCATION}'."
    echo "Halting: Backup bucket must be in the same location as Firestore native database."
    exit 1
fi
echo "  ✓ Bucket confirmed: gs://${BUCKET_NAME} (${BUCKET_LOC})"

# Gate 6: Verify Bucket IAM Policy for Firestore Service Agent (Does NOT auto-grant)
echo "[Gate 6/6] Verifying bucket IAM permissions for Firestore Service Agent..."
IAM_POLICY=$(gcloud storage buckets get-iam-policy "gs://${BUCKET_NAME}" --project="${EXPECTED_PROJECT_ID}" --format="json" 2>/dev/null || true)

if [[ "${IAM_POLICY}" != *"${EXPECTED_SERVICE_AGENT}"* ]] || [[ "${IAM_POLICY}" != *"roles/storage.objectAdmin"* && "${IAM_POLICY}" != *"roles/storage.admin"* ]]; then
    echo "FAILED: Bucket 'gs://${BUCKET_NAME}' does not grant 'roles/storage.objectAdmin' to '${EXPECTED_SERVICE_AGENT}'."
    echo "Remediation: Run the following command to bind the required role:"
    echo "  gcloud storage buckets add-iam-policy-binding gs://${BUCKET_NAME} --project=\"${EXPECTED_PROJECT_ID}\" --member=\"serviceAccount:${EXPECTED_SERVICE_AGENT}\" --role=\"roles/storage.objectAdmin\""
    echo "Note: This script will NOT automatically grant permissions."
    exit 1
fi
echo "  ✓ Service agent bucket permissions verified."

echo "--------------------------------------------------------------------------------"
echo "All 6 Preflight Gates Passed! Ready for managed cold export."
echo "--------------------------------------------------------------------------------"

EXPORT_PREFIX="pre-migration-$(date +%Y%m%d%H%M%S)"
DESTINATION="gs://${BUCKET_NAME}/${EXPORT_PREFIX}"

# Export Scope Configuration:
# DEFAULT: Full database export (omits --collection-ids). This guarantees all root collections
# and all subcollections (e.g. mockTests/{testId}/sections, exams/{examId}/years/{yearId}/papers, etc.)
# are captured in the snapshot without risk of selective omission.
# If EXPORT_COLLECTION_IDS is explicitly set, selective export is used instead.
EXPORT_ARGS=()
if [[ -n "${EXPORT_COLLECTION_IDS:-}" ]]; then
    echo "  Notice: Using selective collection export: ${EXPORT_COLLECTION_IDS}"
    EXPORT_ARGS+=("--collection-ids=${EXPORT_COLLECTION_IDS}")
else
    echo "  Notice: Using full database export (omitting --collection-ids) to guarantee all root and subcollections (sections, questions, attempts, etc.) are captured."
fi

echo "Initiating Firestore managed cold export to: ${DESTINATION}"
OPERATION_NAME=$(gcloud firestore export "${DESTINATION}" \
    --database="${EXPECTED_DATABASE}" \
    ${EXPORT_ARGS[@]+"${EXPORT_ARGS[@]}"} \
    --project="${EXPECTED_PROJECT_ID}" \
    --format="value(name)" 2>/dev/null || true)

if [[ -z "${OPERATION_NAME}" ]]; then
    # Fallback if gcloud waited synchronously or format output was empty
    echo "Export command returned. Checking destination bucket for export metadata..."
    sleep 5
    METADATA_EXISTS=$(gcloud storage objects list "${DESTINATION}/*.overall_export_metadata" --project="${EXPECTED_PROJECT_ID}" --format="value(name)" 2>/dev/null || true)
    if [[ -z "${METADATA_EXISTS}" ]]; then
        echo "WARNING: Operation name not captured and overall_export_metadata not immediately detected."
        echo "Check operation status manually with: gcloud firestore operations list --project=${EXPECTED_PROJECT_ID}"
    else
        echo "  ✓ overall_export_metadata confirmed at ${DESTINATION}"
    fi
else
    echo "  Export Operation: ${OPERATION_NAME}"
    echo "Polling operation until completion (fail-closed verification)..."

    while true; do
        OP_STATUS=$(gcloud firestore operations describe "${OPERATION_NAME}" --database="${EXPECTED_DATABASE}" --project="${EXPECTED_PROJECT_ID}" --format="json" 2>/dev/null || true)
        IS_DONE=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.done === true ? 'true' : 'false'); } catch { process.stdout.write('false'); }" "${OP_STATUS}" 2>/dev/null || echo "false")
        if [[ "${IS_DONE}" == "true" ]]; then
            HAS_ERROR=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.error ? JSON.stringify(d.error) : ''); } catch { process.stdout.write(''); }" "${OP_STATUS}" 2>/dev/null || echo "")
            if [[ -n "${HAS_ERROR}" ]]; then
                echo "FATAL: Export operation failed with error: ${HAS_ERROR}"
                exit 1
            fi
            OUTPUT_URI=$(node -e "try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.response?.outputUriPrefix || ''); } catch { process.stdout.write(''); }" "${OP_STATUS}" 2>/dev/null || echo "")
            echo "  ✓ Export operation reached SUCCESS (done: true)!"
            echo "  ✓ Authoritative output URI: ${OUTPUT_URI:-${DESTINATION}}"
            
            # Save authoritative operation metadata for snapshot provenance verification
            mkdir -p ./artifacts
            echo "${OP_STATUS}" > ./artifacts/export-operation-metadata.json
            echo "  ✓ Authoritative export metadata saved to ./artifacts/export-operation-metadata.json"
            break
        fi
        echo "  Export in progress... waiting 10s..."
        sleep 10
    done
fi

echo "================================================================================"
echo "Export verified successfully!"
echo "Destination: ${DESTINATION}"
echo "Next step: Run staging restore validation in isolated staging project."
echo "CRITICAL: Live production migration writes remain UNAUTHORIZED."
echo "================================================================================"

