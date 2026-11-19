import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createRequire } from "node:module";
import { AdminAuthService } from "../services/admin/adminAuthService.js";
import { StorageVaultService } from "../services/admin/storageVaultService.js";
import { ImportJobPipelineService } from "../services/admin/importJobPipelineService.js";
import { UniversalFirestoreService } from "../services/admin/universalFirestoreService.js";
import { MockTestDeletionService } from "../services/mockTestDeletionService.js";
import { SubjectNormalizationService } from "../services/subjectNormalizationService.js";
import { UIRValidator } from "../services/uir/uirValidator.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const router = express.Router();

// Support larger payload limit for PDF base64 / binary upload on admin routes
router.use(express.json({ limit: "50mb" }));

// ============================================================
// RETIRED BOOTSTRAP & ROLE-GRANTING ENDPOINTS (FAIL CLOSED)
// ============================================================

router.all("/users/bootstrap*", (req, res) => {
    return res.status(405).json({
        success: false,
        error: "Bootstrap via API has been retired. Admin privileges must be granted directly by setting role='admin' in Firestore (users/{uid}) via the Firebase Console."
    });
});

router.all(["/users/assign-role", "/users/revoke-role"], (req, res) => {
    return res.status(405).json({
        success: false,
        error: "Administrative privilege modification via API is disabled. All admin access is managed strictly in the Firebase Console at users/{uid}."
    });
});

// ============================================================
// CENTRALIZED SERVER-VERIFIED FIRESTORE ADMIN AUTHORIZATION
// ============================================================
router.use(AdminAuthService.requireAdmin());

// ============================================================
// 1. ADMIN AUTHENTICATION STATUS CHECK
// ============================================================
router.get("/auth/check", (req, res) => {
    res.json({
        success: true,
        authenticated: true,
        authorized: true,
        uid: req.adminUser.uid,
        actor: req.adminActor,
        email: req.adminEmail,
        role: "admin",
        targetProjectId: req.targetProjectId || (req.adminClient ? req.adminClient.projectId : (process.env.FIREBASE_PROJECT_ID || null)),
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// 2. READ-ONLY ADMINISTRATOR LISTING (For dashboard display)
// ============================================================
router.get("/users", async (req, res) => {
    try {
        const client = req.adminClient || UniversalFirestoreService.forProject(req.targetProjectId);
        // Look up registered admin users from Firestore users collection
        const docs = await client.listDocuments("users");
        const adminUsers = docs
            .filter(u => u.role === "admin")
            .map(u => ({
                uid: u.id || u.uid,
                email: u.email || "",
                name: u.name || "",
                role: "admin",
                status: "active",
                updatedAt: u.updatedAt || u.createdAt || null
            }));

        res.json({
            success: true,
            count: adminUsers.length,
            users: adminUsers
        });
    } catch (err) {
        console.error("[Admin API] Error listing admin users:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 3. DASHBOARD OVERVIEW METRICS
// ============================================================
router.get("/stats", (req, res) => {
    try {
        const jobs = ImportJobPipelineService.listJobs();
        const totalImports = jobs.length;
        const processingJobs = jobs.filter(j => ["queued", "uploading", "extracting_metadata", "extracting_questions", "reconciling_answer_key", "validating_pattern", "writing_draft_records"].includes(j.status)).length;
        const needsReviewJobs = jobs.filter(j => j.status === "needs_review").length;
        const readyToPublishJobs = jobs.filter(j => j.status === "ready_to_publish").length;
        const publishedPapers = jobs.filter(j => j.status === "published").length;
        const failedJobs = jobs.filter(j => j.status === "failed").length;

        res.json({
            success: true,
            stats: {
                totalImports,
                processingJobs,
                needsReviewJobs,
                readyToPublishJobs,
                publishedPapers,
                failedJobs
            }
        });
    } catch (err) {
        console.error("[Admin API] Error calculating stats:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 4. DOCUMENT UPLOAD & CRYPTOGRAPHIC HASHING
// ============================================================
router.post("/import/upload", async (req, res) => {
    try {
        const {
            examName,
            examId = "neet-ug",
            year = 2024,
            paperType = "pyq",
            language = "English",
            paperCode = "Q1",
            questionPaperFile, // { name, base64, size }
            answerKeyFile,     // { name, base64, size }
            examPatternFile,   // { name, base64, size }
            isSyntheticTest = false,
            testRunId = null
        } = req.body || {};

        const rawExam = examName || examId;
        if (!rawExam || typeof rawExam !== "string" || !rawExam.trim()) {
            return res.status(400).json({
                success: false,
                error: "Target Exam name is required and cannot be empty or whitespace only."
            });
        }
        if (rawExam.trim().length > 150) {
            return res.status(400).json({
                success: false,
                error: "Target Exam name cannot exceed 150 characters."
            });
        }

        if (!questionPaperFile?.base64 || !answerKeyFile?.base64 || !examPatternFile?.base64) {
            return res.status(400).json({
                success: false,
                error: "All 3 required source documents must be provided: Question Paper, Answer Key, and Exam Pattern."
            });
        }

        // Decode buffers
        const qpBuffer = Buffer.from(questionPaperFile.base64, "base64");
        const akBuffer = Buffer.from(answerKeyFile.base64, "base64");
        const epBuffer = Buffer.from(examPatternFile.base64, "base64");

        // Validate and store into vault
        const storedQp = await StorageVaultService.storeDocument({
            buffer: qpBuffer,
            originalFilename: questionPaperFile.name || "QuestionPaper.pdf",
            docType: "question_paper"
        });

        const storedAk = await StorageVaultService.storeDocument({
            buffer: akBuffer,
            originalFilename: answerKeyFile.name || "AnswerKey.pdf",
            docType: "answer_key"
        });

        const storedEp = await StorageVaultService.storeDocument({
            buffer: epBuffer,
            originalFilename: examPatternFile.name || "ExamPattern.pdf",
            docType: "exam_pattern"
        });

        // Duplicate Check: Check if identical document hashes were already imported
        const existingJobs = ImportJobPipelineService.listJobs({ examId, status: "published" });
        const duplicateJob = existingJobs.find(j =>
            j.sourceHashes?.questionPaper === storedQp.hash &&
            j.sourceHashes?.answerKey === storedAk.hash
        );

        if (duplicateJob) {
            return res.status(409).json({
                success: false,
                duplicateDetected: true,
                message: `Duplicate upload detected: Identical paper and answer key was already processed in job ${duplicateJob.jobId}`,
                existingJobId: duplicateJob.jobId
            });
        }

        // Create Job Record
        const job = ImportJobPipelineService.createJob({
            examName: rawExam.trim(),
            examId: rawExam.trim(),
            year,
            paperType,
            language,
            paperCode,
            actor: req.adminActor,
            isSyntheticTest,
            testRunId
        });

        await ImportJobPipelineService.attachDocuments(job.jobId, {
            questionPaper: storedQp,
            answerKey: storedAk,
            examPattern: storedEp
        });

        res.json({
            success: true,
            message: "Source documents uploaded and cryptographically verified successfully.",
            jobId: job.jobId,
            examName: job.examName,
            examId: job.examId,
            hashes: {
                questionPaper: storedQp.hash,
                answerKey: storedAk.hash,
                examPattern: storedEp.hash
            }
        });

    } catch (err) {
        console.error("[Admin API] Document upload error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 4B. REMOVE ATTACHED SOURCE DOCUMENT (INDEPENDENT REMOVAL)
// ============================================================
router.delete("/import/jobs/:jobId/documents/:docType", async (req, res) => {
    try {
        const { jobId, docType } = req.params;
        const result = await ImportJobPipelineService.removeDocument({
            jobId,
            docType,
            actor: req.adminActor
        });

        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        console.error("[Admin API] Error removing document:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 5. START PIPELINE EXECUTION
// ============================================================
router.post("/import/start", async (req, res) => {
    try {
        const { jobId } = req.body || {};
        if (!jobId) {
            return res.status(400).json({ success: false, error: "Missing jobId parameter" });
        }

        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
        }

        // Run asynchronously in background
        setImmediate(() => {
            ImportJobPipelineService.runPipeline(jobId).catch(err => {
                console.error(`[Admin API] Background pipeline failure for ${jobId}:`, err.message);
            });
        });

        res.json({
            success: true,
            message: "Pipeline processing started in background.",
            jobId,
            status: "processing"
        });
    } catch (err) {
        console.error("[Admin API] Error starting pipeline:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 6. LIST IMPORT JOBS
// ============================================================
router.get("/import/jobs", async (req, res) => {
    try {
        const { examId, status, search } = req.query;
        await ImportJobPipelineService.syncJobsFromFirestore();
        const jobs = ImportJobPipelineService.listJobs({ examId, status, search });
        res.json({
            success: true,
            count: jobs.length,
            jobs: jobs.map(j => ({
                jobId: j.jobId,
                examId: j.examId,
                year: j.year,
                paperCode: j.paperCode,
                status: j.status,
                stage: j.stage,
                progressPercent: j.progressPercent,
                extractedQuestionCount: j.extractedQuestionCount,
                verifiedAnswerCount: j.verifiedAnswerCount,
                flaggedQuestionCount: j.flaggedQuestionCount,
                canPublish: Boolean(j.validationReport?.canPublish),
                testId: j.publishedMockTestId || j.mockTestId || (j.status === "published" ? (j.draftPackage?.testId || j.testId || (j.isSyntheticTest ? `mock-${j.testRunId}-${j.examId}-${j.year}-${(j.paperCode || '').toLowerCase()}` : `mock-${j.examId}-${j.year}-${(j.paperCode || '').toLowerCase()}`)) : null),
                createdAt: j.createdAt,
                updatedAt: j.updatedAt
            }))
        });
    } catch (err) {
        console.error("[Admin API] Error listing jobs:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 7. GET JOB DETAILS & PROGRESS
// ============================================================
router.get("/import/jobs/:jobId", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        res.json({
            success: true,
            job: {
                ...job,
                // Do not leak secret answer keys in general job status view
                draftPackage: {
                    testId: job.draftPackage?.testId,
                    configId: job.draftPackage?.configId,
                    questionCount: (job.draftPackage?.questions || []).length
                }
            }
        });
    } catch (err) {
        console.error("[Admin API] Error fetching job:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 8. GET VALIDATION REPORT
// ============================================================
router.get("/import/jobs/:jobId/report", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        let discrepancyClassification = null;
        try {
            discrepancyClassification = ImportJobPipelineService.classifyDiscrepancies(job);
        } catch (e) {
            console.warn("[Admin API] Discrepancy classification notice:", e.message);
        }

        res.json({
            success: true,
            jobId: job.jobId,
            examId: job.examId,
            examName: job.examName || job.examId,
            year: job.year,
            paperCode: job.paperCode,
            status: job.status,
            publishedWithValidationOverride: Boolean(job.publishedWithValidationOverride),
            publishedWithDiscrepancies: Boolean(job.publishedWithDiscrepancies),
            publicationMode: job.publicationMode || null,
            publicationMethod: job.publicationMethod || null,
            overrideTimestamp: job.overrideTimestamp || null,
            overrideAdminId: job.overrideAdminId || null,
            overrideReason: job.overrideReason || null,
            validationReport: job.validationReport,
            extractedMetadata: job.extractedMetadata,
            flaggedQuestions: job.flaggedQuestions,
            errors: job.errors,
            warnings: job.warnings,
            discrepancyClassification
        });
    } catch (err) {
        console.error("[Admin API] Error fetching validation report:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 8B. DISCREPANCY CLASSIFICATION & BREAKDOWN
// ============================================================
router.get("/import/jobs/:jobId/discrepancies", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        const classification = ImportJobPipelineService.classifyDiscrepancies(job);
        res.json({
            success: true,
            jobId,
            status: job.status,
            discrepancyClassification: classification,
            ...classification
        });
    } catch (err) {
        console.error("[Admin API] Error calculating discrepancies:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 8C. GET UIR V3.0 CANONICAL DOCUMENT & VALIDATION
// ============================================================
router.get("/import/jobs/:jobId/uir", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        const uirDocument = job.uirDocument || null;
        let validation = null;
        if (uirDocument) {
            validation = UIRValidator.validate(uirDocument);
        }

        res.json({
            success: true,
            jobId: job.jobId,
            examId: job.examId,
            status: job.status,
            uirDocument,
            validation,
            canPublish: Boolean(job.validationReport?.canPublish)
        });
    } catch (err) {
        console.error("[Admin API] Error retrieving UIR document:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 8D. START UNIVERSAL THREE-DOCUMENT INGESTION PIPELINE
// ============================================================
router.post("/import/jobs/:jobId/universal-start", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        setImmediate(() => {
            ImportJobPipelineService.runUniversalPipeline(jobId).catch(err => {
                console.error(`[Admin API] Background universal pipeline failure for ${jobId}:`, err.message);
            });
        });

        res.json({
            success: true,
            message: "Universal three-document pipeline started in background.",
            jobId,
            status: "processing"
        });
    } catch (err) {
        console.error("[Admin API] Error starting universal pipeline:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 9. GET EXTRACTED QUESTIONS (FOR REVIEW)
// ============================================================
router.get("/import/jobs/:jobId/questions", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { flaggedOnly } = req.query;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        let questions = job.draftPackage?.questions || [];
        if (flaggedOnly === "true") {
            questions = questions.filter(q => q.validationStatus === "flagged");
        }

        res.json({
            success: true,
            total: questions.length,
            questions
        });
    } catch (err) {
        console.error("[Admin API] Error fetching questions:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 10. MANUAL QUESTION CORRECTION & AUDIT LOGGING
// ============================================================
router.put("/import/jobs/:jobId/questions/:questionId", async (req, res) => {
    try {
        const { jobId, questionId } = req.params;
        const { updates, reason } = req.body || {};

        if (!reason || reason.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: "An audit reason is required for manual question correction (minimum 5 characters)."
            });
        }

        const result = await ImportJobPipelineService.correctQuestion({
            jobId,
            questionId,
            updates: updates || {},
            actor: req.adminActor,
            reason
        });

        res.json({
            success: true,
            message: `Question ${questionId} updated successfully.`,
            question: result.question
        });
    } catch (err) {
        console.error("[Admin API] Error correcting question:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put("/questions/:questionId", async (req, res) => {
    try {
        const { questionId } = req.params;
        const { updates, reason } = req.body || {};

        if (!reason || reason.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: "An audit reason is required for manual question correction (minimum 5 characters)."
            });
        }

        const client = req.adminClient || UniversalFirestoreService.forProject(req.targetProjectId);
        const questionDoc = await client.getDocument("mockQuestions", questionId);
        if (!questionDoc) {
            return res.status(404).json({ success: false, error: "Question not found" });
        }

        const normSubject = updates && (updates.subject || updates.subjectName || updates.subjectId)
            ? SubjectNormalizationService.normalizeSubject(updates.subjectName || updates.subject || updates.subjectId)
            : null;

        const updated = {
            ...questionDoc,
            ...(updates?.questionText ? { questionText: updates.questionText } : {}),
            ...(Array.isArray(updates?.options) ? { options: updates.options } : {}),
            ...(updates?.questionType ? { questionType: updates.questionType } : {}),
            ...(normSubject ? {
                subject: normSubject.subjectName,
                subjectName: normSubject.subjectName,
                subjectId: normSubject.subjectId
            } : {}),
            ...(updates?.topic ? { topic: updates.topic } : {}),
            updatedAt: new Date().toISOString(),
            lastCorrectedBy: req.adminActor || "admin",
            lastCorrectionReason: reason
        };

        await client.setDocument("mockQuestions", questionId, updated);

        res.json({
            success: true,
            message: `Question ${questionId} updated successfully.`,
            question: updated
        });
    } catch (err) {
        console.error("[Admin API] Error updating question:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 11. PUBLISH TEST (STANDARD PUBLICATION GATE)
// ============================================================
router.post("/import/jobs/:jobId/publish", async (req, res) => {
    try {
        const { jobId } = req.params;
        const result = await ImportJobPipelineService.publishTest({
            jobId,
            actor: req.adminActor
        });

        res.json({
            success: true,
            message: "Test paper has been published successfully and is now active for student mocks.",
            ...result
        });
    } catch (err) {
        console.error("[Admin API] Error publishing test:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 11B. PUBLISH IGNORING DISCREPANCY (CONTROLLED OVERRIDE GATE)
// ============================================================
router.post("/import/jobs/:jobId/publish-override", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { reason, acknowledgedDiscrepancyIds, confirmationText } = req.body || {};

        const result = await ImportJobPipelineService.publishTestOverride({
            jobId,
            actor: req.adminActor,
            reason,
            acknowledgedDiscrepancyIds,
            confirmationText
        });

        res.json({
            success: true,
            message: "Test paper has been published under controlled administrator override.",
            ...result
        });
    } catch (err) {
        console.error("[Admin API] Error publishing test override:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 11C. PHASE 5.12: ADMINISTRATIVE OVERRIDE "IGNORE AND PUBLISH"
// ============================================================
router.post("/mock-tests/:testId/override-publish", async (req, res) => {
    try {
        const { testId } = req.params;
        const { reason } = req.body || {};

        const result = await ImportJobPipelineService.executeValidationOverridePublish({
            testId,
            actor: req.adminActor,
            actorEmail: req.adminEmail,
            reason
        });

        res.json(result);
    } catch (err) {
        console.error("[Admin API] Error in mock-test override-publish:", err.message);
        const status = err.statusCode || (err.message.includes("already published") ? 400 : (err.message.includes("not found") ? 404 : 400));
        res.status(status).json({ success: false, error: err.message });
    }
});

router.post("/import/jobs/:jobId/override-publish", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { reason } = req.body || {};

        const result = await ImportJobPipelineService.executeValidationOverridePublish({
            jobId,
            actor: req.adminActor,
            actorEmail: req.adminEmail,
            reason
        });

        res.json(result);
    } catch (err) {
        console.error("[Admin API] Error in job override-publish:", err.message);
        const status = err.statusCode || (err.message.includes("already published") ? 400 : (err.message.includes("not found") ? 404 : 400));
        res.status(status).json({ success: false, error: err.message });
    }
});

router.get("/mock-tests/:testId/discrepancies", async (req, res) => {
    try {
        const { testId } = req.params;
        let job = null;
        for (const j of ImportJobPipelineService.listJobs()) {
            if (j.publishedMockTestId === testId || j.draftPackage?.testId === testId || j.mockTestId === testId || j.jobId === testId) {
                job = j;
                break;
            }
        }
        if (job) {
            const classification = ImportJobPipelineService.classifyDiscrepancies(job);
            return res.json({
                success: true,
                testId,
                jobId: job.jobId,
                status: job.status,
                discrepancyClassification: classification,
                ...classification
            });
        }

        const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            return res.status(404).json({ success: false, error: "Mock test not found" });
        }

        const rawDiscrepancies = testDoc.overriddenDiscrepancies || testDoc.validationReport?.blockers || testDoc.discrepancies || [];
        const formatted = rawDiscrepancies.map((d, i) => ({
            id: typeof d === "object" ? d.id : `disc_${i + 1}`,
            title: typeof d === "object" ? d.title : (typeof d === "string" ? d : "Discrepancy"),
            severity: typeof d === "object" && d.severity ? d.severity : "warning",
            description: typeof d === "object" ? d.description : (typeof d === "string" ? d : ""),
            questionNumber: typeof d === "object" ? d.questionNumber : null,
            overridable: true
        }));

        res.json({
            success: true,
            testId,
            status: testDoc.status,
            totalDiscrepancies: formatted.length,
            counts: {
                total: formatted.length,
                critical: formatted.filter(f => f.severity === "critical" || f.severity === "fatal").length,
                major: formatted.filter(f => f.severity === "major").length,
                minor: formatted.filter(f => f.severity === "minor").length,
                warning: formatted.filter(f => f.severity === "warning").length,
                other: formatted.filter(f => !["critical", "fatal", "major", "minor", "warning"].includes(f.severity)).length
            },
            allDiscrepancies: formatted
        });
    } catch (err) {
        console.error("[Admin API] Error calculating test discrepancies:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get("/mock-tests/:testId/override-audit", async (req, res) => {
    try {
        const { testId } = req.params;
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            return res.status(404).json({ success: false, error: "Mock test not found" });
        }
        if (!testDoc.publishedWithValidationOverride && testDoc.publicationMethod !== "ADMIN_OVERRIDE") {
            return res.status(404).json({ success: false, error: "Mock test was not published with validation override" });
        }
        const auditLogs = await UniversalFirestoreService.listDocuments("adminAuditLogs");
        const audit = auditLogs.find(a => a.mockTestId === testId || a.auditId === testDoc.overrideAuditId);
        res.json({
            success: true,
            testId,
            audit: audit || {
                mockTestId: testId,
                publicationMethod: testDoc.publicationMethod,
                overrideTimestamp: testDoc.overrideTimestamp || testDoc.publishedAt,
                overrideAdminId: testDoc.overrideAdminId || testDoc.publishedBy,
                overrideReason: testDoc.overrideReason,
                overriddenDiscrepancies: testDoc.overriddenDiscrepancies || []
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 12. RETRY IMPORT JOB
// ============================================================
router.post("/import/jobs/:jobId/retry", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        job.status = "queued";
        job.stage = "Retrying pipeline execution";
        job.progressPercent = 10;
        job.errors = [];

        setImmediate(() => {
            ImportJobPipelineService.runPipeline(jobId).catch(err => {
                console.error(`[Admin API] Pipeline retry error on ${jobId}:`, err.message);
            });
        });

        res.json({
            success: true,
            message: "Job execution restarted.",
            jobId,
            status: "queued"
        });
    } catch (err) {
        console.error("[Admin API] Error retrying job:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 13. AUTHENTICATED SOURCE-PAGE PREVIEW (SECURE PDF STREAMING)
// ============================================================
router.get("/import/jobs/:jobId/source-preview", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { docType = "questionPaper", page = "1", format } = req.query;

        // 1. Validate docType against strict whitelist
        const ALLOWED_DOC_TYPES = ["questionPaper", "answerKey", "examPattern"];
        if (!ALLOWED_DOC_TYPES.includes(docType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid docType '${docType}'. Permitted document types: ${ALLOWED_DOC_TYPES.join(", ")}`
            });
        }

        // 2. Look up job and verify association
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
        }

        const docRef = job.sourceDocuments?.[docType];
        if (!docRef) {
            return res.status(404).json({
                success: false,
                error: `No source document associated for '${docType}' in job ${jobId}`
            });
        }

        // 3. Securely retrieve document buffer (preventing path traversal or arbitrary file access)
        let buffer;
        try {
            buffer = await StorageVaultService.retrieveDocumentBuffer(docRef);
        } catch (storageErr) {
            return res.status(404).json({
                success: false,
                error: `Source document file could not be retrieved from storage vault: ${storageErr.message}`
            });
        }

        // 4. Validate page number bounds against real document
        let totalPages = 1;
        try {
            const parsed = await pdfParse(buffer, { max: 0 });
            totalPages = parsed.numpages || 1;
        } catch (pdfErr) {
            console.warn(`[Admin API] Could not parse page count for preview: ${pdfErr.message}`);
        }

        const pageNum = parseInt(page, 10);
        if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
            return res.status(400).json({
                success: false,
                error: `Page number ${page} is out of bounds. Valid page range is 1 to ${totalPages}.`
            });
        }

        // 5. Respond with metadata or inline stream
        if (format === "metadata") {
            return res.json({
                success: true,
                jobId,
                docType,
                page: pageNum,
                totalPages,
                originalFilename: docRef.originalFilename,
                sizeBytes: buffer.length
            });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${docType}_page_${pageNum}.pdf"`);
        res.setHeader("X-Source-Page", String(pageNum));
        res.setHeader("X-Total-Pages", String(totalPages));
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
        res.send(buffer);

    } catch (err) {
        console.error("[Admin API] Error serving source preview:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 13B. SERVE EXTRACTED DIAGRAM IMAGE (AUTHENTICATED)
// ============================================================
router.get("/vault/diagrams/:filename", async (req, res) => {
    try {
        const { filename } = req.params;
        const safeFilename = path.basename(filename);
        if (!/^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|svg)$/i.test(safeFilename)) {
            return res.status(400).json({ success: false, error: "Invalid diagram filename format" });
        }
        const filePath = path.join(process.cwd(), "uploads", "vault", "diagrams", safeFilename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "Diagram image not found" });
        }
        const ext = path.extname(safeFilename).toLowerCase();
        const contentType = ext === ".svg" ? "image/svg+xml; charset=utf-8" : (ext === ".webp" ? "image/webp" : "image/png");
        res.setHeader("Content-Type", contentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, max-age=3600");
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    } catch (err) {
        console.error("[Admin API] Error serving diagram:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 14. MANUAL ANSWER KEY CORRECTION & AUDIT LOGGING
// ============================================================
router.put("/import/jobs/:jobId/answer-keys/:questionId", async (req, res) => {
    try {
        const { jobId, questionId } = req.params;
        const { updates, reason } = req.body || {};

        if (!reason || reason.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: "An audit reason is required for manual answer key correction (minimum 5 characters)."
            });
        }

        const result = await ImportJobPipelineService.correctAnswerKey({
            jobId,
            questionId,
            updates: updates || {},
            actor: req.adminActor,
            reason
        });

        res.json({
            success: true,
            message: `Answer key for question ${questionId} updated successfully.`,
            answerKey: result.answerKey
        });
    } catch (err) {
        console.error("[Admin API] Error correcting answer key:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 14B. AUTHORIZE OR CORRECT BOOKLET RECONCILIATION
// ============================================================
router.put("/import/jobs/:jobId/authorize-booklet", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { reason, series, code } = req.body || {};

        if (!reason || reason.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: "An audit reason is required for booklet authorization/correction (minimum 5 characters)."
            });
        }

        const result = await ImportJobPipelineService.authorizeBookletCorrection({
            jobId,
            actor: req.adminActor,
            reason: reason.trim(),
            series,
            code
        });

        res.json({
            success: true,
            message: "Booklet series/code reconciliation explicitly authorized.",
            job: result.job
        });
    } catch (err) {
        console.error("[Admin API] Error authorizing booklet:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================
// 15. RESOLVE MOCK TESTS ASSOCIATED WITH AN IMPORT JOB
// ============================================================
router.get("/import/jobs/:jobId/mock-tests", async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await ImportJobPipelineService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }

        const client = req.adminClient || (req.targetProjectId ? UniversalFirestoreService.forProject(req.targetProjectId) : null);
        if (!client) {
            return res.status(503).json({ success: false, error: "No bound Firestore client available for resolving job mock tests" });
        }
        const allTests = await client.listDocuments("mockTests");
        const matchingTests = allTests.filter(t => 
            t.testId === job.draftPackage?.testId ||
            t.testId === job.publishedMockTestId ||
            t.testId === job.mockTestId ||
            t.testId === job.testId ||
            (t.examId === job.examId && String(t.year) === String(job.year) && t.paperCode === job.paperCode)
        ).map(t => ({
            testId: t.testId,
            title: t.title || `${t.examId} ${t.year} (${t.paperCode})`,
            examId: t.examId,
            examName: t.examName || t.examId,
            year: t.year,
            paperCode: t.paperCode,
            status: t.status,
            totalQuestions: (t.questionIds || []).length
        }));

        res.json({
            success: true,
            jobId,
            tests: matchingTests,
            hasPublishedTests: matchingTests.length > 0
        });
    } catch (err) {
        console.error("[Admin API] Error resolving job mock tests:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 15B. GENERATE IMPORT JOB DELETION MANIFEST (PREVIEW AUDIT)
// ============================================================
router.get("/import/jobs/:jobId/deletion-manifest", async (req, res) => {
    try {
        const { jobId } = req.params;
        const manifest = await MockTestDeletionService.generateJobDeletionManifest({
            jobId,
            adminUid: req.adminUser.uid,
            reason: req.query.reason || "Admin inspection for job deletion",
            options: { client: req.adminClient, projectId: req.targetProjectId }
        });

        res.json({
            success: true,
            manifest
        });
    } catch (err) {
        console.error("[Admin API] Error generating job deletion manifest:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message });
    }
});

// ============================================================
// 15C. PERMANENT IMPORT JOB & DRAFT DATA DELETION
// ============================================================
router.delete("/import/jobs/:jobId", async (req, res) => {
    try {
        const { jobId } = req.params;
        const { confirmation, reason, operationId } = req.body || {};

        if (!confirmation) {
            return res.status(400).json({
                success: false,
                error: `Confirmation required: Please provide the exact job ID '${jobId}' in the request body as confirmation.`
            });
        }

        const summary = await MockTestDeletionService.executeJobDeletion({
            operationId,
            jobId,
            confirmation,
            adminUid: req.adminUser.uid,
            reason: reason || "Administrator permanent job deletion",
            options: { client: req.adminClient, projectId: req.targetProjectId }
        });

        res.json({
            success: true,
            message: `Import job '${jobId}' and all associated exclusive draft records have been permanently deleted.`,
            ...summary
        });
    } catch (err) {
        console.error("[Admin API] Error executing job deletion:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            operationId: err.operationId || null,
            currentStage: err.currentStage || null
        });
    }
});

// ============================================================
// 16. GENERATE MOCK TEST DELETION MANIFEST (PREVIEW AUDIT)
// ============================================================
router.get("/mock-tests/:testId/deletion-manifest", async (req, res) => {
    try {
        const { testId } = req.params;
        const manifest = await MockTestDeletionService.generateDeletionManifest({
            testId,
            jobId: req.query.jobId || null,
            adminUid: req.adminUser.uid,
            reason: req.query.reason || "Admin inspection for deletion",
            options: { client: req.adminClient, projectId: req.targetProjectId }
        });

        res.json({
            success: true,
            manifest
        });
    } catch (err) {
        console.error("[Admin API] Error generating deletion manifest:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            unverified: Boolean(err.unverified)
        });
    }
});

// ============================================================
// 17. PERMANENT MOCK TEST DELETION ENDPOINT
// ============================================================
router.delete("/mock-tests/:testId", async (req, res) => {
    try {
        const { testId } = req.params;
        const { confirmation, reason, operationId, jobId } = req.body || {};

        if (!confirmation) {
            return res.status(400).json({
                success: false,
                error: `Confirmation required: Please provide the exact test ID '${testId}' in the request body as confirmation.`
            });
        }

        const summary = await MockTestDeletionService.executeDeletion({
            operationId,
            testId,
            jobId,
            confirmation,
            adminUid: req.adminUser.uid,
            reason: reason || "Administrator permanent deletion",
            options: { client: req.adminClient, projectId: req.targetProjectId }
        });

        const message = summary.status === "NOTHING_TO_DELETE" || summary.nothingToDelete
            ? `Nothing to delete: Backend verified that test '${testId}' and all associated records are already absent.`
            : `Mock test '${testId}' and all associated exclusive records have been permanently deleted.`;

        res.json({
            success: true,
            message,
            ...summary
        });
    } catch (err) {
        console.error("[Admin API] Error executing mock test deletion:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            operationId: err.operationId || null,
            currentStage: err.currentStage || null
        });
    }
});

// ============================================================
// 18. INSPECT DELETION OPERATION STATUS
// ============================================================
router.get("/mock-tests/deletions/:operationId", async (req, res) => {
    try {
        const { operationId } = req.params;
        const operation = await MockTestDeletionService.getDeletionOperation(operationId, {
            client: req.adminClient,
            projectId: req.targetProjectId
        });
        res.json({
            success: true,
            operation
        });
    } catch (err) {
        console.error("[Admin API] Error retrieving deletion operation:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message });
    }
});

// ============================================================
// 19. RETRY INCOMPLETE DELETION OPERATION
// ============================================================
router.post("/mock-tests/deletions/:operationId/retry", async (req, res) => {
    try {
        const { operationId } = req.params;
        const result = await MockTestDeletionService.retryDeletion({
            operationId,
            adminUid: req.adminUser.uid,
            options: { client: req.adminClient, projectId: req.targetProjectId }
        });

        res.json({
            success: true,
            message: `Deletion operation '${operationId}' resumed and completed.`,
            ...result
        });
    } catch (err) {
        console.error("[Admin API] Error retrying deletion operation:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            operationId
        });
    }
});

export default router;

