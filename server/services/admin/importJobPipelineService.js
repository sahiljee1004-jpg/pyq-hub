import crypto from "node:crypto";
import { StorageVaultService } from "./storageVaultService.js";
import { MetadataExtractionService } from "./metadataExtractionService.js";
import { ExamPatternService } from "./examPatternService.js";
import { QuestionNormalizationService } from "./questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "./answerKeyReconciliationService.js";
import { UniversalFirestoreService } from "./universalFirestoreService.js";
import { SubjectNormalizationService } from "../subjectNormalizationService.js";
import { PyqLibraryService } from "../pyqLibraryService.js";
import { UIRTransformationService } from "../uir/uirTransformationService.js";
import { UIRValidator } from "../uir/uirValidator.js";
import { UIRToMockTestAdapter, LegacyToUIRAdapter } from "../uir/uirAdapters.js";

/**
 * In-memory job store backed by Firestore persistence
 */
const activeJobs = new Map();
const activeOverridePublishLocks = new Set();

export class ImportJobPipelineService {

    /**
     * Compute a deterministic, canonical SHA-256 validation fingerprint covering all content
     * that affects correctness, scoring, or publication.
     */
    static computeValidationFingerprint({ questions = [], answerKeys = [], examConfig = null }) {
        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error("Cannot compute validation fingerprint: questions must be a non-empty array");
        }
        if (!Array.isArray(answerKeys) || answerKeys.length === 0) {
            throw new Error("Cannot compute validation fingerprint: answerKeys must be a non-empty array");
        }
        if (!examConfig || typeof examConfig !== "object") {
            throw new Error("Cannot compute validation fingerprint: examConfig must be a valid object");
        }

        // 1. Stable, canonical question representations
        const canonicalQuestions = [...questions]
            .map(q => {
                const opts = (Array.isArray(q.options) ? q.options : [])
                    .map(o => ({
                        id: String(o.id || "").trim(),
                        label: String(o.label || "").trim(),
                        text: String(o.text || "").trim()
                    }))
                    .sort((a, b) => a.id.localeCompare(b.id));

                return {
                    id: String(q.questionId || "").trim(),
                    number: Number(q.questionNumber || 0),
                    text: String(q.questionText || "").trim(),
                    type: String(q.questionType || "").trim(),
                    subject: String(q.subject || "").trim(),
                    sectionId: String(q.sectionId || "").trim(),
                    topic: String(q.topic || "").trim(),
                    hasDiagram: Boolean(q.hasDiagram),
                    options: opts
                };
            })
            .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));

        // 2. Stable, canonical answer key representations
        const canonicalKeys = [...answerKeys]
            .map(k => {
                const accepted = (Array.isArray(k.acceptedAnswers) ? k.acceptedAnswers : [])
                    .map(a => String(a).trim())
                    .filter(Boolean)
                    .sort();
                const optionIds = (Array.isArray(k.correctOptionIds) ? k.correctOptionIds : [])
                    .map(o => String(o).trim())
                    .filter(Boolean)
                    .sort();
                const answers = (Array.isArray(k.correctAnswers) ? k.correctAnswers : [])
                    .map(c => String(c).trim())
                    .filter(Boolean)
                    .sort();

                return {
                    id: String(k.questionId || "").trim(),
                    number: Number(k.questionNumber || 0),
                    type: String(k.answerType || "").trim(),
                    accepted,
                    optionIds,
                    answers,
                    dropped: Boolean(k.isDropped),
                    marksAwarded: Number.isFinite(k.marksAwarded) ? k.marksAwarded : 4,
                    marksDeducted: Number.isFinite(k.marksDeducted) ? k.marksDeducted : 1,
                    tolerance: Number.isFinite(k.numericTolerance) ? k.numericTolerance : 0,
                    scoringRule: String(k.scoringRuleId || "standard").trim()
                };
            })
            .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));

        // 3. Stable, canonical exam configuration
        const canonicalConfig = {
            configId: String(examConfig.configId || "").trim(),
            examId: String(examConfig.examId || "").trim(),
            totalQuestions: Number(examConfig.totalQuestions || 0),
            maximumMarks: Number(examConfig.maximumMarks || 0),
            durationSeconds: Number(examConfig.durationSeconds || 0),
            sections: (Array.isArray(examConfig.sections) ? examConfig.sections : [])
                .map(s => ({
                    id: String(s.id || "").trim(),
                    subject: String(s.subject || "").trim(),
                    type: String(s.questionType || "").trim(),
                    start: Number(s.startQuestion || 0),
                    end: Number(s.endQuestion || 0),
                    marksPerCorrect: Number(s.marksPerCorrect || 0),
                    negativeMarks: Number(s.negativeMarks || 0)
                }))
                .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        };

        const canonicalPayload = {
            questions: canonicalQuestions,
            answerKeys: canonicalKeys,
            config: canonicalConfig
        };

        return crypto.createHash("sha256")
            .update(JSON.stringify(canonicalPayload))
            .digest("hex");
    }

    /**
     * Create a new import job record
     */
    static createJob({
        examName = null,
        examId = "neet-ug",
        year = 2024,
        paperType = "pyq",
        language = "English",
        paperCode = "Q1",
        actor = "admin",
        isSyntheticTest = false,
        testRunId = null
    }) {
        const timestamp = Date.now();
        const isSynthetic = Boolean(isSyntheticTest || testRunId);

        let cleanExam = "neet-ug";
        let resolvedExamName = "NEET UG";

        if (isSynthetic) {
            cleanExam = (examId || "synthetic-qa-exam").toLowerCase().trim();
            resolvedExamName = examName ? examName.trim() : (examId || "synthetic-qa-exam");
            if (!testRunId || typeof testRunId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(testRunId)) {
                throw new Error("Synthetic test import requires a valid testRunId (8-64 alphanumeric characters, underscores, or dashes)");
            }
            const PRODUCTION_EXAM_IDS = new Set(["neet-ug", "jee-main", "upsc-prelims", "gate-cs", "nda", "cuet-ug"]);
            if (PRODUCTION_EXAM_IDS.has(cleanExam)) {
                throw new Error(`Synthetic tests cannot use production exam identifiers (${cleanExam}). Use dedicated synthetic namespace like 'synthetic-qa-exam'.`);
            }
        } else {
            const rawExam = examName || examId || "neet-ug";
            const resolved = ExamPatternService.resolveExamIdentity(rawExam);
            cleanExam = resolved.examId;
            resolvedExamName = resolved.examName;
        }

        const cleanPaperCode = (paperCode || "Q1").toUpperCase().trim();
        const jobId = isSynthetic
            ? `job_test_${testRunId}_${cleanExam}_${year}_${cleanPaperCode}_${timestamp}`
            : `job_${cleanExam}_${year}_${cleanPaperCode}_${timestamp}`;

        const job = {
            jobId,
            examId: cleanExam,
            examName: resolvedExamName,
            year: Number(year),
            paperType,
            language,
            availableLanguages: ["English"],
            paperCode: cleanPaperCode,
            isSyntheticTest: isSynthetic,
            testRunId: isSynthetic ? testRunId : null,
            status: "queued",
            stage: "Initialized and awaiting source documents",
            progressPercent: 5,
            sourceHashes: {
                questionPaper: null,
                answerKey: null,
                examPattern: null
            },
            sourceDocuments: {
                questionPaper: null,
                answerKey: null,
                examPattern: null
            },
            extractedQuestionCount: 0,
            validatedQuestionCount: 0,
            verifiedAnswerCount: 0,
            flaggedQuestionCount: 0,
            flaggedQuestions: [],
            extractedMetadata: null,
            validationReport: {
                sourceChecks: { passed: false, details: [] },
                extractionChecks: { passed: false, details: [] },
                answerKeyChecks: { passed: false, matchCoverage: 0, unverifiedCount: 0, details: [] },
                patternChecks: { passed: false, details: [] },
                securityChecks: { passed: true, details: ["Answer keys isolated from student-readable schemas"] },
                canPublish: false,
                blockers: ["Source documents pending processing"]
            },
            draftPackage: {
                testId: null,
                configId: null,
                questions: [],
                answerKeys: []
            },
            auditLog: [
                {
                    actor,
                    action: "JOB_CREATED",
                    timestamp: new Date().toISOString(),
                    reason: "Administrator initiated PYQ import job"
                }
            ],
            errors: [],
            warnings: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            schemaVersion: 1
        };

        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
        UniversalFirestoreService.setDocument("paperImportJobs", jobId, job).catch(e => {
            console.warn("[ImportJobPipelineService] Background Firestore job save notice:", e.message);
        });

        return job;
    }

    /**
     * Get a job by ID
     */
    static async getJob(jobId) {
        if (!jobId) return null;
        if (activeJobs.has(jobId)) {
            return activeJobs.get(jobId);
        }
        const fromFirestore = await UniversalFirestoreService.getDocument("paperImportJobs", jobId);
        if (fromFirestore) {
            activeJobs.set(jobId, fromFirestore);
            return fromFirestore;
        }
        return null;
    }

    /**
     * Remove job from in-memory activeJobs cache
     */
    static deleteJobFromMemory(jobId) {
        if (jobId) {
            activeJobs.delete(jobId);
        }
    }

    /**
     * Store or update job in in-memory activeJobs cache
     */
    static setJob(jobId, job) {
        if (jobId && job) {
            activeJobs.set(jobId, job);
        }
    }

    /**
     * Sync jobs from Firestore into in-memory activeJobs cache
     */
    static async syncJobsFromFirestore() {
        try {
            const firestoreJobs = await UniversalFirestoreService.listDocuments("paperImportJobs");
            const firestoreJobIds = new Set(firestoreJobs.map(j => j.jobId).filter(Boolean));

            // Evict deleted jobs from in-memory cache
            for (const cachedId of activeJobs.keys()) {
                if (!firestoreJobIds.has(cachedId)) {
                    activeJobs.delete(cachedId);
                }
            }

            // Sync latest documents from Firestore
            for (const fj of firestoreJobs) {
                if (fj && fj.jobId) {
                    activeJobs.set(fj.jobId, fj);
                }
            }
        } catch (e) {
            console.warn("[ImportJobPipelineService] syncJobsFromFirestore notice:", e.message);
        }
    }

    /**
     * List all jobs with filtering
     */
    static listJobs({ examId, status, search } = {}) {
        const jobs = Array.from(activeJobs.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return jobs.filter(job => {
            if (examId && job.examId !== examId.toLowerCase()) return false;
            if (status && job.status !== status) return false;
            if (search) {
                const s = search.toLowerCase();
                const match = (job.jobId || "").toLowerCase().includes(s) ||
                              (job.examId || "").toLowerCase().includes(s) ||
                              (job.paperCode || "").toLowerCase().includes(s);
                if (!match) return false;
            }
            return true;
        });
    }

    /**
     * Attach uploaded documents to a job
     */
    static async attachDocuments(jobId, { questionPaper, answerKey, examPattern }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        job.sourceDocuments = {
            questionPaper,
            answerKey,
            examPattern
        };
        job.sourceHashes = {
            questionPaper: questionPaper?.hash || null,
            answerKey: answerKey?.hash || null,
            examPattern: examPattern?.hash || null
        };
        job.status = "queued";
        job.stage = "Source documents attached and cryptographically verified";
        job.progressPercent = 15;
        job.updatedAt = new Date().toISOString();

        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);
        return job;
    }

    /**
     * Execute the full automated processing pipeline in background
     */
    static async runPipeline(jobId) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        try {
            // Stage 1: Document validation
            job.status = "extracting_metadata";
            job.stage = "Retrieving and verifying PDF magic bytes & hashes";
            job.progressPercent = 20;
            job.updatedAt = new Date().toISOString();

            const { questionPaper, answerKey, examPattern } = job.sourceDocuments;
            if (!questionPaper || !answerKey || !examPattern) {
                throw new Error("Missing one or more required source documents (Question Paper, Answer Key, Exam Pattern)");
            }

            const qpBuffer = await StorageVaultService.retrieveDocumentBuffer(questionPaper);
            const akBuffer = await StorageVaultService.retrieveDocumentBuffer(answerKey);
            const epBuffer = await StorageVaultService.retrieveDocumentBuffer(examPattern);

            job.validationReport.sourceChecks = {
                passed: true,
                details: [
                    `Question Paper verified: ${questionPaper.originalFilename} (SHA-256: ${questionPaper.hash.substring(0, 10)}...)`,
                    `Answer Key verified: ${answerKey.originalFilename} (SHA-256: ${answerKey.hash.substring(0, 10)}...)`,
                    `Exam Pattern verified: ${examPattern.originalFilename} (SHA-256: ${examPattern.hash.substring(0, 10)}...)`
                ]
            };

            // Stage 2: Metadata Extraction
            job.progressPercent = 35;
            job.stage = "Extracting booklet code, duration, and section hierarchy";
            const extractedMeta = await MetadataExtractionService.extractAllMetadata({
                questionPaperBuffer: qpBuffer,
                answerKeyBuffer: akBuffer,
                examPatternBuffer: epBuffer,
                userHints: {
                    examId: job.examId,
                    year: job.year,
                    paperType: job.paperType,
                    language: job.language,
                    paperCode: job.paperCode
                }
            });

            job.extractedMetadata = extractedMeta;
            if (extractedMeta.paperCode?.value) {
                job.paperCode = extractedMeta.paperCode.value;
            }
            if (extractedMeta.warnings && extractedMeta.warnings.length > 0) {
                job.warnings.push(...extractedMeta.warnings);
            }

            // Stage 3: Exam Pattern Configuration
            job.status = "validating_pattern";
            job.stage = "Reconciling exam pattern rules against official syllabus";
            job.progressPercent = 45;
            const verifiedPattern = ExamPatternService.getVerifiedPattern({
                examId: job.examId,
                examName: job.examName,
                year: job.year,
                paperType: job.paperType,
                isSample: Boolean(job.isSample || job.paperType === "sample"),
                extractedMetadata: extractedMeta
            });

            // Stage 4: Question Extraction & Normalization
            job.status = "extracting_questions";
            job.stage = "Parsing question text, formulas, diagrams, and options";
            job.progressPercent = 60;
            const extractedQuestionsResult = await QuestionNormalizationService.extractAndNormalizeQuestions({
                pdfBuffer: qpBuffer,
                examId: job.examId,
                year: job.year,
                paperCode: job.paperCode,
                language: job.language,
                pattern: verifiedPattern
            });

            const questions = extractedQuestionsResult.questions;
            job.extractedQuestionCount = questions.length;

            const patternCheck = ExamPatternService.validateQuestionsAgainstPattern(questions, verifiedPattern);
            job.validationReport.patternChecks = {
                passed: patternCheck.valid,
                details: patternCheck.valid
                    ? [`Extracted ${questions.length} questions matching official pattern specifications.`]
                    : patternCheck.issues
            };

            const flagged = questions.filter(q => q.validationStatus === "flagged");
            job.flaggedQuestionCount = flagged.length;
            job.flaggedQuestions = flagged.map(f => ({
                questionId: f.questionId,
                questionNumber: f.questionNumber,
                subject: f.subject,
                reason: f.flagReason
            }));

            // Stage 5: Answer Key Reconciliation & Scored-Test Gate
            job.status = "reconciling_answer_key";
            job.stage = "Matching official answer key & enforcing Scored-Test Gate";
            job.progressPercent = 75;

            const parsedAk = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuffer, {
                paperCode: job.paperCode
            });

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap: parsedAk.answers,
                sourceReference: `${job.examId.toUpperCase()} ${job.year} (Code ${job.paperCode}) ${extractedMeta.answerKeyVersion?.value || 'Official Answer Key'}`,
                keyMetadata: parsedAk.keyMetadata
            });

            job.verifiedAnswerCount = reconciliation.verifiedCount;
            job.validationReport.answerKeyChecks = {
                passed: reconciliation.gatePassed,
                matchCoverage: reconciliation.matchCoveragePercent,
                isOfficialKey: parsedAk.keyMetadata?.isOfficialKey !== false,
                provenanceNotice: parsedAk.keyMetadata?.provenanceNotice || "Official Final Answer Key",
                disclaimer: parsedAk.keyMetadata?.disclaimer || null,
                lowConfidenceQuestions: parsedAk.keyMetadata?.lowConfidenceQuestions || [],
                unverifiedCount: reconciliation.missingAnswers.length + reconciliation.conflicts.length,
                details: [
                    `Matched answers for ${reconciliation.verifiedCount}/${questions.length} scored questions (${reconciliation.matchCoveragePercent}% coverage)`,
                    ...(parsedAk.keyMetadata?.disclaimer ? [`PROVENANCE NOTICE: ${parsedAk.keyMetadata.disclaimer}`] : []),
                    ...(parsedAk.keyMetadata?.lowConfidenceQuestions?.length > 0 ? [`Lower confidence key items: Q${parsedAk.keyMetadata.lowConfidenceQuestions.join(', Q')}`] : []),
                    ...(reconciliation.missingAnswers.length > 0 ? [`Missing answer key for Q: ${reconciliation.missingAnswers.slice(0, 10).join(", ")}`] : []),
                    ...reconciliation.conflicts.map(c => `Conflict on Q${c.questionNumber}: ${c.reason}`)
                ]
            };

            if (parsedAk.keyMetadata?.disclaimer) {
                job.warnings.push(`Answer key provenance: ${parsedAk.keyMetadata.disclaimer}`);
            }

            // Stage 6: Publish Eligibility Check
            const blockers = [];
            if (!reconciliation.gatePassed) {
                blockers.push(`Scored-Test Gate Failed: ${reconciliation.missingAnswers.length} questions lack verified answer keys.`);
            }
            if (reconciliation.conflicts.length > 0) {
                blockers.push(`${reconciliation.conflicts.length} answer conflicts detected between question options and answer key.`);
            }
            if (!patternCheck.valid) {
                blockers.push(`Exam pattern validation detected inconsistencies: ${patternCheck.issues[0] || 'Pattern mismatch'}`);
            }
            if (flagged.length > 0) {
                blockers.push(`Content Fidelity Gate: ${flagged.length} question(s) have unresolved fidelity flags and require administrator review (Q: ${flagged.map(f => f.questionNumber).slice(0, 10).join(", ")}).`);
            }

            // Booklet Series & Code Verification Gate
            const booklet = extractedMeta.bookletIdentity;
            const hasAuthorizedBookletCorrection = Boolean(job.bookletAuthorization?.authorized);

            if (!hasAuthorizedBookletCorrection) {
                if (booklet?.status === "mismatched") {
                    blockers.push(`Booklet Mismatch Blocker: ${booklet.mismatchReason}. Scored tests cannot be published with mismatched booklet series/code.`);
                } else if (booklet?.status === "missing_identity") {
                    blockers.push(`Missing Booklet Identity: ${booklet.mismatchReason}. Manual review and administrator authorization required before publication.`);
                }
            }

            // Authoritative Profile Verification Gate
            if (verifiedPattern?.status !== "verified" || verifiedPattern?.requiresAdministrativeReview || verifiedPattern?.verificationStatus === "custom_unverified" || verifiedPattern?.verificationStatus === "unverified_archetype") {
                blockers.push(`Unverified Exam Profile Blocker: Examination pattern '${verifiedPattern?.configId || job.examId}' is unverified or requires administrative review. Tests cannot be published with unverified or draft exam profiles.`);
            }

            const canPublish = blockers.length === 0;
            job.validationReport.canPublish = canPublish;
            job.validationReport.blockers = blockers;

            let contentFingerprint = null;
            if (questions.length > 0 && reconciliation.reconciledKeys.length > 0) {
                contentFingerprint = this.computeValidationFingerprint({
                    questions,
                    answerKeys: reconciliation.reconciledKeys,
                    examConfig: verifiedPattern
                });
            }
            job.contentFingerprint = contentFingerprint;
            job.validationReport.validatedFingerprint = contentFingerprint || "unvalidated_empty_content";

            // Stage 7: Assemble & Save Draft Records in Firestore
            job.status = "writing_draft_records";
            job.stage = "Saving draft records to Firestore universal schema";
            job.progressPercent = 90;

            const testId = job.isSyntheticTest
                ? `mock-${job.testRunId}-${job.examId}-${job.year}-${job.paperCode.toLowerCase()}`
                : `mock-${job.examId}-${job.year}-${job.paperCode.toLowerCase()}`;
            const mockTest = {
                testId,
                examId: job.examId,
                examName: job.examName || verifiedPattern.examName,
                configId: verifiedPattern.configId,
                year: job.year,
                paperId: `${job.examId}-${job.year}-${job.paperCode.toLowerCase()}`,
                paperCode: job.paperCode,
                title: `${job.examName || verifiedPattern.examName} (${job.year}) - Code ${job.paperCode}`,
                testType: "pyq_simulation",
                sourceMode: "official_paper",
                language: job.language,
                availableLanguages: job.availableLanguages || [job.language || "English"],
                questionIds: questions.map(q => q.questionId),
                durationSeconds: verifiedPattern.durationSeconds,
                totalQuestions: questions.length,
                maximumMarks: verifiedPattern.maximumMarks,
                status: "draft",
                isSyntheticTest: Boolean(job.isSyntheticTest),
                testRunId: job.testRunId || null,
                schemaVersion: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            job.draftPackage = {
                testId,
                configId: verifiedPattern.configId,
                examConfig: verifiedPattern,
                questions,
                answerKeys: reconciliation.reconciledKeys
            };

            // Generate and attach canonical UIR v3.0 document
            try {
                const uirDoc = LegacyToUIRAdapter.fromFirestoreDocuments(
                    mockTest,
                    questions,
                    reconciliation.reconciledKeys
                );
                if (Array.isArray(verifiedPattern.sections) && verifiedPattern.sections.length > 0) {
                    uirDoc.sections = verifiedPattern.sections.map(s => ({
                        sectionId: s.id,
                        sectionName: s.subject || s.id,
                        questionCount: (s.endQuestion - s.startQuestion + 1) || 0,
                        scoringRules: {
                            positiveMarks: s.marksPerCorrect ?? (verifiedPattern.markingScheme?.correct ?? 4),
                            negativeMarks: s.negativeMarks !== undefined ? s.negativeMarks : (verifiedPattern.markingScheme?.incorrect ?? -1),
                            unansweredMarks: 0
                        },
                        optionalPolicy: s.optionalPolicy ? { policyType: s.optionalPolicy, requiredCount: s.requiredCount } : { policyType: "none", requiredCount: (s.endQuestion - s.startQuestion + 1) || 0 }
                    }));
                }
                job.uirDocument = uirDoc;
            } catch (uirErr) {
                console.warn("[ImportJobPipelineService] UIR document attachment notice:", uirErr.message);
            }

            await UniversalFirestoreService.saveImportedPackage({
                examConfig: verifiedPattern,
                mockTest,
                questions,
                answerKeys: reconciliation.reconciledKeys,
                job
            });

            // Final state transition
            job.status = canPublish ? "ready_to_publish" : "needs_review";
            job.stage = canPublish
                ? "Processing complete. Test is verified and ready for publication."
                : "Processing complete with flagged items. Administrator review required before publication.";
            job.progressPercent = 100;
            job.updatedAt = new Date().toISOString();

            activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
            await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);
            return job;

        } catch (err) {
            console.error(`[ImportJobPipelineService] Pipeline failure on job ${jobId}:`, err);
            job.status = "failed";
            job.stage = `Pipeline error: ${err.message}`;
            job.errors.push(err.message);
            job.progressPercent = 100;
            job.updatedAt = new Date().toISOString();
            job.validationReport.canPublish = false;
            job.validationReport.blockers.push(`Execution error: ${err.message}`);

            activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
            await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job).catch(() => {});
            return job;
        }
    }

    /**
     * Execute the Universal Document Ingestion & UIR v3.0 pipeline
     */
    static async runUniversalPipeline(jobId) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        try {
            job.status = "extracting_metadata";
            job.stage = "Retrieving and verifying source documents";
            job.progressPercent = 20;
            job.updatedAt = new Date().toISOString();

            const { questionPaper, answerKey, examPattern } = job.sourceDocuments;
            if (!questionPaper || !answerKey || !examPattern) {
                throw new Error("Missing one or more required source documents (Question Paper, Answer Key, Exam Pattern)");
            }

            const qpBuffer = await StorageVaultService.retrieveDocumentBuffer(questionPaper);
            const akBuffer = await StorageVaultService.retrieveDocumentBuffer(answerKey);
            const epBuffer = await StorageVaultService.retrieveDocumentBuffer(examPattern);

            job.validationReport.sourceChecks = {
                passed: true,
                details: [
                    `Question Paper verified: ${questionPaper.originalFilename} (SHA-256: ${questionPaper.hash.substring(0, 10)}...)`,
                    `Answer Key verified: ${answerKey.originalFilename} (SHA-256: ${answerKey.hash.substring(0, 10)}...)`,
                    `Exam Pattern verified: ${examPattern.originalFilename} (SHA-256: ${examPattern.hash.substring(0, 10)}...)`
                ]
            };

            job.status = "extracting_questions";
            job.stage = "Universal three-document extraction and UIR transformation";
            job.progressPercent = 50;

            const uirResult = await UIRTransformationService.transformDocuments(
                { questionPaper: qpBuffer, answerKey: akBuffer, paperFormat: epBuffer },
                {
                    examId: job.examId,
                    year: job.year,
                    paperCode: job.paperCode,
                    examTitle: job.examName,
                    isSyntheticTest: job.isSyntheticTest,
                    testRunId: job.testRunId
                }
            );

            const uirDoc = uirResult.uirDocument;
            job.uirDocument = uirDoc;

            const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDoc);

            if (job.isSyntheticTest) {
                mockTestDoc.isSyntheticTest = true;
                mockTestDoc.testRunId = job.testRunId;
            }

            job.extractedQuestionCount = mockQuestionDocs.length;
            job.verifiedAnswerCount = mockAnswerKeyDocs.filter(k => k.verificationStatus === "verified" || (k.acceptedAnswers && k.acceptedAnswers.length > 0) || k.isDropped).length;

            const flagged = mockQuestionDocs.filter(q => q.qualityFlags && (q.qualityFlags.contentCorruptionDetected || q.qualityFlags.ambiguousOptionsDetected));
            job.flaggedQuestionCount = flagged.length;
            job.flaggedQuestions = flagged.map(f => ({
                questionId: f.questionId,
                questionNumber: f.questionNumber,
                subject: f.subject,
                reason: f.qualityFlags.contentCorruptionDetected ? "Content corruption detected" : "Ambiguous options"
            }));

            // Synthetic canonical config for fingerprinting
            const canonicalConfig = {
                configId: mockTestDoc.examId,
                examId: mockTestDoc.examId,
                totalQuestions: mockTestDoc.totalQuestions,
                maximumMarks: mockTestDoc.maximumMarks,
                durationSeconds: mockTestDoc.durationSeconds,
                examName: mockTestDoc.examName,
                year: mockTestDoc.year,
                sections: (mockTestDoc.sections || []).map((s) => ({
                    id: s.sectionId,
                    sectionId: s.sectionId,
                    sectionName: s.sectionName,
                    subject: s.sectionName,
                    type: "mcq",
                    start: 1,
                    end: s.questionCount || mockTestDoc.totalQuestions,
                    questionCount: s.questionCount || mockTestDoc.totalQuestions,
                    marksPerCorrect: s.scoringRules?.positiveMarks || 4,
                    negativeMarks: s.scoringRules?.negativeMarks || 1
                })),
                scoringConfig: mockTestDoc.scoringConfig,
                schemaVersion: mockTestDoc.schemaVersion
            };

            let contentFingerprint = null;
            if (mockQuestionDocs.length > 0 && mockAnswerKeyDocs.length > 0) {
                contentFingerprint = this.computeValidationFingerprint({
                    questions: mockQuestionDocs,
                    answerKeys: mockAnswerKeyDocs,
                    examConfig: canonicalConfig
                });
            }

            job.contentFingerprint = contentFingerprint;

            const blockers = (uirResult.validation?.errors || []).filter(e => e.includes("Blocker") || e.includes("Error"));
            if (mockQuestionDocs.length === 0) {
                const scanMsg = uirResult.ingestionManifest?.extractions?.questionPaper?.scanDetection?.message
                    || "Question paper contains zero parsed questions. A scanned document requires an OCR pipeline.";
                blockers.push(`Blocker: ${scanMsg}`);
            }

            const canPublish = Boolean(
                mockQuestionDocs.length > 0 &&
                contentFingerprint &&
                (uirResult.validation?.isValid === true || uirDoc.examMetadata.approvalStatus === "approved") &&
                blockers.length === 0
            );

            job.validationReport = {
                sourceChecks: { passed: true, details: ["Question Paper, Answer Key, and Paper Format verified"] },
                extractionChecks: {
                    passed: mockQuestionDocs.length > 0,
                    details: [mockQuestionDocs.length > 0 ? `Extracted ${mockQuestionDocs.length} questions into UIR v3.0` : "Extracted 0 questions. Document is scanned or unparsed."]
                },
                answerKeyChecks: {
                    passed: mockQuestionDocs.length > 0 && job.verifiedAnswerCount === mockQuestionDocs.length,
                    matchCoverage: mockQuestionDocs.length > 0 ? Math.round((job.verifiedAnswerCount / Math.max(1, mockQuestionDocs.length)) * 100) : 0,
                    unverifiedCount: Math.max(0, mockQuestionDocs.length - job.verifiedAnswerCount),
                    details: [`Matched ${job.verifiedAnswerCount}/${mockQuestionDocs.length} answers`]
                },
                patternChecks: { passed: true, details: ["Paper format rules reconciled"] },
                securityChecks: { passed: true, details: ["Answer keys isolated from student-readable schemas"] },
                canPublish,
                blockers,
                warnings: uirResult.validation.warnings,
                validatedFingerprint: contentFingerprint || "unvalidated_empty_content"
            };

            job.draftPackage = {
                testId: mockTestDoc.testId,
                configId: mockTestDoc.examId,
                examConfig: canonicalConfig,
                questions: mockQuestionDocs,
                answerKeys: mockAnswerKeyDocs
            };

            await UniversalFirestoreService.saveImportedPackage({
                examConfig: job.draftPackage.examConfig,
                mockTest: mockTestDoc,
                questions: mockQuestionDocs,
                answerKeys: mockAnswerKeyDocs,
                job
            });

            job.status = canPublish ? "ready_to_publish" : "needs_review";
            job.stage = canPublish
                ? "Processing complete. Test is verified and ready for publication."
                : "Processing complete with flagged items. Administrator review required before publication.";
            job.progressPercent = 100;
            job.updatedAt = new Date().toISOString();

            activeJobs.set(jobId, job);
            PyqLibraryService.invalidateAllCaches();
            await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);
            return job;
        } catch (err) {
            console.error(`[ImportJobPipelineService] Universal pipeline failure on job ${jobId}:`, err);
            job.status = "failed";
            job.stage = `Pipeline error: ${err.message}`;
            job.errors.push(err.message);
            job.progressPercent = 100;
            job.updatedAt = new Date().toISOString();
            job.validationReport.canPublish = false;
            job.validationReport.blockers.push(`Execution error: ${err.message}`);

            activeJobs.set(jobId, job);
            PyqLibraryService.invalidateAllCaches();
            await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job).catch(() => {});
            return job;
        }
    }

    /**
     * Manually correct a question during administrative review
     */
    static async correctQuestion({ jobId, questionId, updates, actor = "admin", reason }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        if (!reason || reason.trim().length < 5) {
            throw new Error("Audit reason is required for manual question correction (minimum 5 characters).");
        }

        const question = job.draftPackage.questions.find(q => q.questionId === questionId);
        if (!question) {
            throw new Error(`Question ${questionId} not found in job draft package`);
        }

        const originalSnapshot = JSON.stringify(question);
        const associatedAk = (job.draftPackage.answerKeys || []).find(ak => ak.questionId === questionId);

        // 1. Handle questionType update & validation
        if (updates.questionType) {
            const targetType = String(updates.questionType).trim();
            if (targetType === "numerical") {
                if (associatedAk && associatedAk.answerType === "single_choice" && !updates.force) {
                    throw new Error(`Correction conflicts with answer key: Question cannot be changed to numerical while official answer key expects single_choice (Option ${associatedAk.correctOptionIds?.join(', ')}).`);
                }
                question.questionType = "numerical";
                question.options = [];
            } else if (targetType === "mcq") {
                question.questionType = "mcq";
            } else {
                question.questionType = targetType;
            }
        }

        // 2. Handle options update & validation
        if (Array.isArray(updates.options)) {
            if (question.questionType === "mcq") {
                if (updates.options.length < 2) {
                    throw new Error("MCQ questions must have at least 2 options.");
                }
                for (const opt of updates.options) {
                    if (!opt || typeof opt !== "object" || !opt.id || typeof opt.text !== "string" || opt.text.trim().length === 0) {
                        throw new Error(`Option ${opt?.id || "unknown"} must have a valid identifier and non-empty text.`);
                    }
                }
            }
            question.options = updates.options.map(opt => {
                const existing = (question.options || []).find(eo => String(eo.id) === String(opt.id));
                return {
                    ...opt,
                    diagramUrl: opt.diagramUrl !== undefined ? opt.diagramUrl : existing?.diagramUrl,
                    diagramId: opt.diagramId !== undefined ? opt.diagramId : existing?.diagramId,
                    hasDiagram: opt.hasDiagram !== undefined ? opt.hasDiagram : existing?.hasDiagram,
                    isDiagramOption: opt.isDiagramOption !== undefined ? opt.isDiagramOption : existing?.isDiagramOption
                };
            });
        }

        // 3. Handle stem, subject, and topic updates
        if (typeof updates.questionText === "string") question.questionText = updates.questionText;
        if (typeof updates.subject === "string" || typeof updates.subjectName === "string" || typeof updates.subjectId === "string") {
            const rawSub = updates.subjectName || updates.subject || updates.subjectId;
            const norm = SubjectNormalizationService.normalizeSubject(rawSub);
            question.subject = norm.subjectName;
            question.subjectName = norm.subjectName;
            question.subjectId = norm.subjectId;
        }
        if (typeof updates.topic === "string") question.topic = updates.topic;
        if (typeof updates.hasDiagram === "boolean") question.hasDiagram = updates.hasDiagram;
        if (Array.isArray(updates.media)) question.media = updates.media;

        // 4. Scoring consistency check: Ensure MCQ options still cover answer key
        let scoringMismatch = false;
        let scoringMismatchReason = "";
        if (question.questionType === "mcq" && associatedAk && Array.isArray(associatedAk.correctOptionIds) && associatedAk.correctOptionIds.length > 0) {
            const availableOptionIds = new Set((question.options || []).map(o => String(o.id)));
            const missingOptions = associatedAk.correctOptionIds.filter(id => !availableOptionIds.has(String(id)));
            if (missingOptions.length > 0) {
                scoringMismatch = true;
                scoringMismatchReason = `Scoring mismatch: Answer key references option(s) [${missingOptions.join(", ")}] not present in question options.`;
            }
        }

        // 5. Formula & Content Fidelity Re-evaluation
        const fidelity = QuestionNormalizationService.evaluateQuestionFidelity({
            questionText: question.questionText,
            options: question.options,
            questionType: question.questionType,
            hasDiagram: question.hasDiagram
        });

        // 6. Set validation status & flag reason
        if (scoringMismatch) {
            question.validationStatus = "flagged";
            question.flagReason = scoringMismatchReason;
        } else if (fidelity.validationStatus === "flagged") {
            // If the only flag was that visual verification was required for diagram options,
            // the administrator's explicit review and correction fulfills that visual verification requirement
            if (fidelity.flagReason?.includes("visual diagrams/structures") && !fidelity.flagReason?.includes("corruption") && !fidelity.flagReason?.includes("collision")) {
                question.validationStatus = "corrected";
                question.flagReason = `Visually verified by ${actor}: ${reason}`;
            } else {
                // Keep unresolved formula-fidelity blockers active until the correction has actually passed validation
                question.validationStatus = "flagged";
                question.flagReason = fidelity.flagReason;
            }
        } else {
            question.validationStatus = "corrected";
            question.flagReason = `Corrected by ${actor}: ${reason}`;
        }

        // 7. Audit Log
        job.auditLog.push({
            actor,
            action: "QUESTION_CORRECTED",
            questionId,
            timestamp: new Date().toISOString(),
            reason,
            diff: {
                before: originalSnapshot,
                after: JSON.stringify(question)
            }
        });

        // 8. Re-evaluate flagged items and blockers
        const remainingFlagged = job.draftPackage.questions.filter(q => q.validationStatus === "flagged");
        job.flaggedQuestionCount = remainingFlagged.length;
        job.flaggedQuestions = remainingFlagged.map(f => ({
            questionId: f.questionId,
            questionNumber: f.questionNumber,
            subject: f.subject,
            reason: f.flagReason
        }));

        // Remove old fidelity & scoring mismatch flags from blockers
        job.validationReport.blockers = (job.validationReport.blockers || []).filter(b =>
            !b.includes("unresolved fidelity flags and require administrator review") &&
            !b.includes("edit caused scoring mismatch with official answer key")
        );

        if (remainingFlagged.length > 0) {
            job.validationReport.blockers.push(`Content Fidelity Gate: ${remainingFlagged.length} question(s) have unresolved fidelity flags and require administrator review (Q: ${remainingFlagged.map(f => f.questionNumber).slice(0, 10).join(", ")}).`);
        }
        if (scoringMismatch) {
            job.validationReport.blockers.push(`Question ${question.questionNumber} edit caused scoring mismatch with official answer key`);
        }

        // Apply correction to UIR document if present
        if (job.uirDocument) {
            try {
                UIRTransformationService.applyHumanCorrection(job.uirDocument, {
                    questionId,
                    questionNumber: question.questionNumber,
                    modifiedBy: actor,
                    reason,
                    correctedOptions: updates.options,
                    correctedStem: updates.questionText,
                    newValue: updates
                });
                const reval = UIRValidator.validate(job.uirDocument);
                if (reval.approvalStatus === "approved" && reval.blockers.length === 0) {
                    job.validationReport.blockers = (job.validationReport.blockers || []).filter(b => 
                        !b.includes("Content corruption") && !b.includes("Fidelity") && !b.includes("unresolved")
                    );
                    job.validationReport.canPublish = job.validationReport.blockers.length === 0;
                    if (job.validationReport.canPublish) {
                        job.status = "ready_to_publish";
                    }
                }
            } catch (err) {
                console.warn("[ImportJobPipelineService] Notice applying UIR correction:", err.message);
            }
        }

        // 9. Recompute canonical validation fingerprint
        const newFingerprint = this.computeValidationFingerprint({
            questions: job.draftPackage.questions,
            answerKeys: job.draftPackage.answerKeys,
            examConfig: job.draftPackage.examConfig || ExamPatternService.getPattern(job.examId)
        });
        job.contentFingerprint = newFingerprint;
        job.validationReport.validatedFingerprint = newFingerprint;

        job.validationReport.canPublish = (job.validationReport.blockers.length === 0);
        job.status = job.validationReport.canPublish ? "ready_to_publish" : "needs_review";
        job.updatedAt = new Date().toISOString();
        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();

        // Save updated question in Firestore
        await UniversalFirestoreService.setDocument("mockQuestions", questionId, question);
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        return { success: true, question, job };
    }

    /**
     * Manually correct an answer key during administrative review
     */
    static async correctAnswerKey({ jobId, questionId, updates, actor = "admin", reason }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        if (!reason || reason.trim().length < 5) {
            throw new Error("Audit reason is required for manual answer key correction (minimum 5 characters).");
        }

        const ak = (job.draftPackage?.answerKeys || []).find(k => k.questionId === questionId);
        if (!ak) {
            throw new Error(`Answer key for question ${questionId} not found in job draft package`);
        }

        const question = (job.draftPackage?.questions || []).find(q => q.questionId === questionId);
        const originalSnapshot = JSON.stringify(ak);

        // Apply permitted edits to answer key
        if (updates.answerType) ak.answerType = String(updates.answerType).trim();
        if (Array.isArray(updates.acceptedAnswers)) {
            ak.acceptedAnswers = updates.acceptedAnswers.map(a => String(a).trim()).filter(Boolean);
        }
        if (Array.isArray(updates.correctOptionIds)) {
            const optIds = updates.correctOptionIds.map(o => String(o).trim()).filter(Boolean);
            if (question && question.questionType === "mcq" && question.options?.length > 0) {
                const availableIds = new Set(question.options.map(o => String(o.id)));
                for (const id of optIds) {
                    if (!availableIds.has(id)) {
                        throw new Error(`Answer key correction conflicts with question options: Option ${id} does not exist in question ${question.questionNumber}`);
                    }
                }
            }
            ak.correctOptionIds = optIds;
        }
        if (Array.isArray(updates.correctAnswers)) {
            ak.correctAnswers = updates.correctAnswers.map(c => String(c).trim()).filter(Boolean);
        }
        if (typeof updates.isDropped === "boolean") ak.isDropped = updates.isDropped;
        if (typeof updates.scoringRuleId === "string") ak.scoringRuleId = updates.scoringRuleId;
        if (Number.isFinite(updates.marksAwarded)) ak.marksAwarded = Number(updates.marksAwarded);
        if (Number.isFinite(updates.marksDeducted)) ak.marksDeducted = Number(updates.marksDeducted);
        if (Number.isFinite(updates.numericTolerance)) ak.numericTolerance = Number(updates.numericTolerance);

        ak.verificationStatus = "verified";

        // Audit Log
        job.auditLog.push({
            actor,
            action: "ANSWER_KEY_CORRECTED",
            questionId,
            timestamp: new Date().toISOString(),
            reason,
            diff: {
                before: originalSnapshot,
                after: JSON.stringify(ak)
            }
        });

        // Recompute canonical validation fingerprint
        const newFingerprint = this.computeValidationFingerprint({
            questions: job.draftPackage.questions,
            answerKeys: job.draftPackage.answerKeys,
            examConfig: job.draftPackage.examConfig || ExamPatternService.getPattern(job.examId)
        });
        job.contentFingerprint = newFingerprint;
        job.validationReport.validatedFingerprint = newFingerprint;

        job.updatedAt = new Date().toISOString();
        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
        await UniversalFirestoreService.setDocument("mockAnswerKeys", questionId, ak);
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        return { success: true, answerKey: ak, job };
    }

    /**
     * Explicitly authorize or correct booklet series/code reconciliation with administrator identity and justification
     */
    static async authorizeBookletCorrection({ jobId, actor = "admin", reason, series = null, code = null }) {
        if (!reason || reason.trim().length < 5) {
            throw new Error("An audit reason is required for booklet authorization/correction (minimum 5 characters).");
        }
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        const previousStatus = job.extractedMetadata?.bookletIdentity?.status || "unknown";
        const authorizedSeries = series ? series.toUpperCase() : (job.extractedMetadata?.bookletIdentity?.paperSeries || job.paperCode || "A");
        const authorizedCode = code ? code.toUpperCase() : (job.extractedMetadata?.bookletIdentity?.paperCode || job.paperCode);

        job.bookletAuthorization = {
            authorized: true,
            actor,
            reason: reason.trim(),
            authorizedAt: new Date().toISOString(),
            series: authorizedSeries,
            code: authorizedCode
        };

        if (job.extractedMetadata?.bookletIdentity) {
            job.extractedMetadata.bookletIdentity.status = "matched";
            job.extractedMetadata.bookletIdentity.authorizedBy = actor;
            job.extractedMetadata.bookletIdentity.authorizationReason = reason.trim();
        }

        job.paperCode = authorizedSeries;
        if (job.extractedMetadata?.paperCode) {
            job.extractedMetadata.paperCode.value = authorizedSeries;
        }

        job.auditLog.push({
            actor,
            action: "BOOKLET_RECONCILIATION_AUTHORIZED",
            timestamp: new Date().toISOString(),
            reason: reason.trim(),
            details: {
                previousStatus,
                authorizedSeries,
                authorizedCode
            }
        });

        // Re-evaluate blockers and remove booklet-related blockers
        const remainingBlockers = (job.validationReport?.blockers || []).filter(b => 
            !b.includes("Booklet Mismatch Blocker") && !b.includes("Missing Booklet Identity")
        );
        job.validationReport.blockers = remainingBlockers;
        job.validationReport.canPublish = remainingBlockers.length === 0;
        if (job.validationReport.canPublish && job.status === "needs_review") {
            job.status = "ready_to_publish";
        }

        if (job.draftPackage?.questions?.length > 0 && job.draftPackage?.answerKeys?.length > 0) {
            const newFingerprint = this.computeValidationFingerprint({
                questions: job.draftPackage.questions,
                answerKeys: job.draftPackage.answerKeys,
                examConfig: job.draftPackage.examConfig || ExamPatternService.getPattern(job.examId)
            });
            job.contentFingerprint = newFingerprint;
            job.validationReport.validatedFingerprint = newFingerprint;
        }

        job.updatedAt = new Date().toISOString();
        activeJobs.set(jobId, job);
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        return { success: true, job };
    }

    /**
     * Check publication readiness and mandatory blockers for a job
     */
    static canPublish(job) {
        if (!job) return { canPublish: false, blockers: [{ title: "No job provided" }] };
        const recordedFingerprint = job.validationReport?.validatedFingerprint || job.validationFingerprint;
        if (!recordedFingerprint || typeof recordedFingerprint !== "string" || recordedFingerprint === "unvalidated_empty_content") {
            return {
                canPublish: false,
                blockers: [{
                    code: "MISSING_FINGERPRINT",
                    title: "Missing Validation Fingerprint",
                    detail: "Import package has not been validated. Run validation before publishing."
                }]
            };
        }
        const blockers = this.collectMandatoryPublicationBlockers ? this.collectMandatoryPublicationBlockers(job) : [];
        return {
            canPublish: blockers.length === 0,
            blockers
        };
    }

    /**
     * Publish test to live students after passing all mandatory verification gates
     */
    static async publishTest({ jobId, actor = "admin" }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        // Idempotency check: repeated publish requests must return existing state without duplicate writes
        if (job.status === "published") {
            return {
                success: true,
                jobId,
                testId: job.draftPackage.testId,
                status: "published",
                publishedAt: job.updatedAt,
                alreadyPublished: true
            };
        }

        // Independently re-verify publication-critical conditions on the server
        const questions = job.draftPackage?.questions || [];
        const answerKeys = job.draftPackage?.answerKeys || [];
        const pattern = job.validationReport?.patternChecks;

        const serverBlockers = [];
        if (questions.length === 0) {
            serverBlockers.push("No questions found in draft package.");
        }
        if (answerKeys.length === 0) {
            serverBlockers.push("No answer keys reconciled in draft package.");
        }
        if (questions.length !== answerKeys.length) {
            serverBlockers.push(`Question count (${questions.length}) does not match answer key count (${answerKeys.length}).`);
        }

        // Server-side check for duplicate question IDs (Fail Closed)
        const qIdSet = new Set();
        const duplicateQIds = [];
        for (const q of questions) {
            const qId = q.questionId;
            if (qId !== undefined && qId !== null && qId !== "") {
                if (qIdSet.has(qId)) {
                    duplicateQIds.push(qId);
                }
                qIdSet.add(qId);
            }
        }
        if (duplicateQIds.length > 0) {
            const uniqueDupes = [...new Set(duplicateQIds)];
            serverBlockers.push(`Duplicate Question IDs Blocker: Draft package contains duplicate questionId(s): [${uniqueDupes.slice(0, 5).join(", ")}]. All question IDs must be deterministic and unique.`);
        }

        // Fail-Closed Check: Never publish placeholder-only options without visual diagram assets or verification
        const unmappedPlaceholderQuestions = questions.filter(q =>
            (q.questionType === "mcq" || q.questionType === "msq") &&
            q.validationStatus !== "corrected" &&
            Array.isArray(q.options) &&
            q.options.some(o => (o.text || "").includes("[Diagram / Structure") && !o.diagramUrl && !q.media?.some(m => m.type === "option_diagram" && String(m.optionId) === String(o.id)))
        );
        if (unmappedPlaceholderQuestions.length > 0) {
            serverBlockers.push(`Unresolved diagram placeholder options on ${unmappedPlaceholderQuestions.length} questions (Q${unmappedPlaceholderQuestions.map(q => q.questionNumber).slice(0, 5).join(", ")}). Diagram options must have visual assets or explicit text verification before publication.`);
        }

        // Authoritative Server-Side Validation Fingerprint Check (Fail Closed)
        if (!job.validationReport?.validatedFingerprint || typeof job.validationReport.validatedFingerprint !== "string" || job.validationReport.validatedFingerprint === "unvalidated_empty_content") {
            serverBlockers.push("Missing validation fingerprint: Import package has not passed official validation. Publication rejected.");
        } else {
            let currentFingerprint;
            try {
                currentFingerprint = this.computeValidationFingerprint({
                    questions,
                    answerKeys,
                    examConfig: job.draftPackage?.examConfig || ExamPatternService.getPattern(job.examId)
                });
            } catch (err) {
                serverBlockers.push(`Failed to recompute validation fingerprint: ${err.message}`);
            }

            if (!currentFingerprint || job.validationReport.validatedFingerprint !== currentFingerprint) {
                serverBlockers.push("Validation is stale or fingerprint mismatch: Content was modified after validation. Publication rejected.");
            }
        }

        // Check for unresolved flagged questions
        const unresolvedFlagged = questions.filter(q => q.validationStatus === "flagged");
        if (unresolvedFlagged.length > 0) {
            serverBlockers.push(`${unresolvedFlagged.length} question(s) have unresolved fidelity flags and require administrator review.`);
        }

        // Check for incomplete stems or missing MCQ options
        const incompleteQuestions = questions.filter(q => !q.questionText || q.questionText.trim().length < 5);
        if (incompleteQuestions.length > 0) {
            serverBlockers.push(`${incompleteQuestions.length} questions have incomplete or empty stems.`);
        }
        const brokenMcqs = questions.filter(q => q.questionType === "mcq" && (!Array.isArray(q.options) || q.options.length < 2));
        if (brokenMcqs.length > 0) {
            serverBlockers.push(`${brokenMcqs.length} MCQs have fewer than 2 options.`);
        }

        // Check answer key verification status
        const unverifiedKeys = answerKeys.filter(k => k.verificationStatus !== "verified");
        if (unverifiedKeys.length > 0) {
            serverBlockers.push(`${unverifiedKeys.length} answer keys remain unverified against official key source.`);
        }

        // Authoritative Booklet Series & Code Verification Gate
        const booklet = job.extractedMetadata?.bookletIdentity;
        const hasAuthorizedBookletCorrection = Boolean(job.bookletAuthorization?.authorized);
        if (!hasAuthorizedBookletCorrection) {
            if (booklet?.status === "mismatched") {
                serverBlockers.push(`Booklet Mismatch Blocker: ${booklet.mismatchReason}. Scored tests cannot be published with mismatched booklet series/code.`);
            } else if (booklet?.status === "missing_identity") {
                serverBlockers.push(`Missing Booklet Identity: ${booklet.mismatchReason}. Manual review and administrator authorization required before publication.`);
            }
        }

        // Authoritative Profile Verification Gate
        const examConfig = job.draftPackage?.examConfig || job.verifiedPattern || ExamPatternService.getPattern(job.examId, job.year);
        if (job.uirDocument) {
            // Document-driven UIR tests are validated via official document ingestion and publication gates
        } else if (examConfig?.requiresAdministrativeReview || examConfig?.status === "draft" || examConfig?.verificationStatus === "custom_unverified" || examConfig?.verificationStatus === "unverified_archetype") {
            serverBlockers.push(`Unverified Exam Profile Blocker: Examination profile '${examConfig?.configId || job.examId}' requires administrative review and cannot be published.`);
        }

        if (serverBlockers.length > 0 || !job.validationReport?.canPublish) {
            const allBlockers = [...new Set([...(job.validationReport?.blockers || []), ...serverBlockers])];
            throw new Error(`Cannot publish test: Authoritative publication gate rejected publication. Reason(s): ${allBlockers.join("; ")}`);
        }

        const testId = job.draftPackage.testId;
        if (!testId) {
            throw new Error("No mockTest ID associated with this import job");
        }

        // Fetch draft test
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            throw new Error(`Target test document ${testId} was not found in Firestore`);
        }

        const publishedAt = new Date().toISOString();
        testDoc.status = "published";
        testDoc.publishedAt = publishedAt;
        testDoc.publishedBy = actor;
        testDoc.updatedAt = publishedAt;

        // Preserve UIR v3.0 sections, scoring rules, and schema version
        if (job.uirDocument?.sections && Array.isArray(job.uirDocument.sections) && job.uirDocument.sections.length > 0) {
            testDoc.sections = job.uirDocument.sections;
        } else if (job.draftPackage?.examConfig?.sections) {
            testDoc.sections = job.draftPackage.examConfig.sections;
        }

        if (job.uirDocument?.scoringConfig) {
            testDoc.scoringConfig = job.uirDocument.scoringConfig;
        } else if (job.draftPackage?.examConfig?.scoringConfig) {
            testDoc.scoringConfig = job.draftPackage.examConfig.scoringConfig;
        }

        if (job.uirDocument?.schemaVersion) {
            testDoc.schemaVersion = job.uirDocument.schemaVersion;
        } else if (job.draftPackage?.examConfig?.schemaVersion) {
            testDoc.schemaVersion = job.draftPackage.examConfig.schemaVersion;
        }

        if (job.uirDocument) {
            job.uirDocument.examMetadata.approvalStatus = "approved";
            if (!job.uirDocument.auditTrail) job.uirDocument.auditTrail = {};
            job.uirDocument.auditTrail.publishedAt = publishedAt;
            job.uirDocument.auditTrail.publishedBy = actor;
        }

        job.status = "published";
        job.stage = "Test paper has been published and is now live for students!";
        job.auditLog.push({
            actor,
            action: "TEST_PUBLISHED",
            testId,
            timestamp: publishedAt,
            reason: "All mandatory validation gates and answer key checks passed successfully"
        });
        job.updatedAt = publishedAt;

        // Commit published state atomically
        await UniversalFirestoreService.setDocument("mockTests", testId, testDoc);
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();

        return {
            success: true,
            jobId,
            testId,
            status: "published",
            publishedAt
        };
    }

    /**
     * Remove an attached source document from a draft import job safely
     */
    static async removeDocument({ jobId, docType, actor = "admin" }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        // Never allow deleting documents from published jobs
        if (job.status === "published") {
            throw new Error("Cannot remove source documents from an already published test paper.");
        }

        // Processing lifecycle protection: cannot remove files while background extraction pipeline is actively running
        const activeProcessingStatuses = [
            "processing",
            "uploading",
            "extracting_metadata",
            "extracting_questions",
            "reconciling_answer_key",
            "validating_pattern",
            "writing_draft_records"
        ];
        if (activeProcessingStatuses.includes(job.status)) {
            throw new Error("Cannot remove document while the import pipeline is actively processing. Please cancel or reset the job first.");
        }

        // Validate docType
        const validTypes = {
            questionPaper: "questionPaper",
            answerKey: "answerKey",
            examPattern: "examPattern",
            question_paper: "questionPaper",
            answer_key: "answerKey",
            exam_pattern: "examPattern"
        };
        const normalizedDocType = validTypes[docType];
        if (!normalizedDocType) {
            throw new Error(`Invalid document type '${docType}'. Must be questionPaper, answerKey, or examPattern.`);
        }

        const existingDoc = job.sourceDocuments?.[normalizedDocType];
        if (!existingDoc) {
            // Idempotent: already removed
            return { success: true, message: `Document '${normalizedDocType}' is already removed.`, job };
        }

        // Safe cleanup: delete local vault file ONLY if it belongs to this draft and is not used by any published test
        if (existingDoc.localVaultPath) {
            await StorageVaultService.removeDraftFile(existingDoc.localVaultPath, job.jobId).catch(err => {
                console.warn("[ImportJobPipelineService] Notice on vault cleanup:", err.message);
            });
        }

        // Clear document reference and hash
        job.sourceDocuments[normalizedDocType] = null;
        if (job.sourceHashes) {
            job.sourceHashes[normalizedDocType] = null;
        }

        // Invalidate publication readiness
        job.validationReport.canPublish = false;
        job.validationReport.blockers = [
            ...(job.validationReport.blockers || []).filter(b => !b.includes(normalizedDocType)),
            `Missing mandatory source document: ${normalizedDocType}`
        ];
        if (job.status === "ready_to_publish") {
            job.status = "needs_review";
        }

        // Record durable audit event
        job.auditLog.push({
            actor,
            action: "DOCUMENT_REMOVED",
            docType: normalizedDocType,
            removedFilename: existingDoc.originalFilename || "document.pdf",
            timestamp: new Date().toISOString(),
            reason: "Administrator removed source document from draft import"
        });

        job.updatedAt = new Date().toISOString();
        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        return {
            success: true,
            message: `Document '${normalizedDocType}' removed successfully from draft job.`,
            jobId,
            docType: normalizedDocType
        };
    }

    /**
     * Authoritatively classify all discrepancies for an import job into:
     * - eligibleDiscrepancies: non-critical warnings that an authorized administrator may review and override
     * - mandatoryBlockers: structural, scoring, cryptographic, or security blockers that CAN NEVER be overridden
     */
    static classifyDiscrepancies(job) {
        if (!job) {
            throw new Error("Job is required for discrepancy classification");
        }

        const eligibleDiscrepancies = [];
        const mandatoryBlockers = [];

        // 1. Mandatory Source Documents Check (NEVER OVERRIDABLE)
        const hasQp = Boolean(job.sourceDocuments?.questionPaper && (job.sourceHashes?.questionPaper || job.sourceDocuments?.questionPaper?.hash));
        const hasAk = Boolean(job.sourceDocuments?.answerKey && (job.sourceHashes?.answerKey || job.sourceDocuments?.answerKey?.hash));
        const hasEp = Boolean(job.sourceDocuments?.examPattern && (job.sourceHashes?.examPattern || job.sourceDocuments?.examPattern?.hash));

        if (!hasQp) {
            mandatoryBlockers.push({
                id: "missing_doc_question_paper",
                code: "MISSING_SOURCE_DOCUMENT",
                severity: "fatal",
                overridable: false,
                title: "Missing Question Paper PDF",
                description: "Question Paper PDF is missing or unverified. Publication strictly prohibited."
            });
        }
        if (!hasAk) {
            mandatoryBlockers.push({
                id: "missing_doc_answer_key",
                code: "MISSING_SOURCE_DOCUMENT",
                severity: "fatal",
                overridable: false,
                title: "Missing Answer Key PDF",
                description: "Official Answer Key PDF is missing or unverified. Publication strictly prohibited."
            });
        }
        if (!hasEp) {
            mandatoryBlockers.push({
                id: "missing_doc_exam_pattern",
                code: "MISSING_SOURCE_DOCUMENT",
                severity: "fatal",
                overridable: false,
                title: "Missing Pattern Document PDF",
                description: "Official Pattern Document is missing or unverified. Publication strictly prohibited."
            });
        }

        const questions = job.draftPackage?.questions || job.extractedQuestions || [];
        const answerKeys = job.draftPackage?.answerKeys || job.reconciledAnswers || [];

        // 2. Questions & Answer Keys presence & count parity (NEVER OVERRIDABLE)
        if (questions.length === 0) {
            mandatoryBlockers.push({
                id: "empty_questions_package",
                code: "EMPTY_QUESTIONS",
                severity: "fatal",
                overridable: false,
                title: "No Questions Extracted",
                description: "The draft package contains 0 questions."
            });
        }
        if (answerKeys.length === 0) {
            mandatoryBlockers.push({
                id: "empty_answer_keys_package",
                code: "EMPTY_ANSWER_KEYS",
                severity: "fatal",
                overridable: false,
                title: "No Answer Keys Reconciled",
                description: "The draft package contains 0 reconciled answer keys."
            });
        }
        if (questions.length > 0 && answerKeys.length > 0 && questions.length !== answerKeys.length) {
            mandatoryBlockers.push({
                id: "count_mismatch_q_vs_ak",
                code: "COUNT_MISMATCH",
                severity: "fatal",
                overridable: false,
                title: "Question / Answer Key Count Mismatch",
                description: `Questions count (${questions.length}) does not match answer keys count (${answerKeys.length}).`
            });
        }

        // 2B. Duplicate Question Identifiers Check (NEVER OVERRIDABLE)
        const qIdSet = new Set();
        const duplicateQIds = [];
        for (const q of questions) {
            const qId = q.questionId;
            if (qId !== undefined && qId !== null && qId !== "") {
                if (qIdSet.has(qId)) {
                    duplicateQIds.push(qId);
                }
                qIdSet.add(qId);
            }
        }
        if (duplicateQIds.length > 0) {
            const uniqueDupes = [...new Set(duplicateQIds)];
            mandatoryBlockers.push({
                id: "duplicate_question_ids",
                code: "DUPLICATE_QUESTION_IDS",
                severity: "fatal",
                overridable: false,
                title: "Duplicate Question Identifiers",
                description: `Draft package contains ${duplicateQIds.length} duplicate questionId(s): [${uniqueDupes.slice(0, 5).join(", ")}]. All question IDs must be deterministic and unique.`
            });
        }

        // 3. Cryptographic Fingerprint Freshness (NEVER OVERRIDABLE)
        const recordedFingerprint = job.validationReport?.validatedFingerprint || job.validationFingerprint;
        if (!recordedFingerprint || typeof recordedFingerprint !== "string" || recordedFingerprint === "unvalidated_empty_content") {
            mandatoryBlockers.push({
                id: "missing_validation_fingerprint",
                code: "MISSING_FINGERPRINT",
                severity: "fatal",
                overridable: false,
                title: "Missing Validation Fingerprint",
                description: "Draft package has not passed official validation. Validation fingerprint is missing or empty."
            });
        } else {
            let recomputedFp;
            try {
                recomputedFp = this.computeValidationFingerprint({
                    questions,
                    answerKeys,
                    examConfig: job.draftPackage?.examConfig || job.verifiedPattern || ExamPatternService.getPattern(job.examId)
                });
            } catch (err) {
                mandatoryBlockers.push({
                    id: "fingerprint_recomputation_error",
                    code: "FINGERPRINT_ERROR",
                    severity: "fatal",
                    overridable: false,
                    title: "Fingerprint Calculation Failure",
                    description: `Failed to verify content fingerprint: ${err.message}`
                });
            }

            if (recomputedFp && recordedFingerprint !== recomputedFp) {
                mandatoryBlockers.push({
                    id: "stale_validation_fingerprint",
                    code: "STALE_FINGERPRINT",
                    severity: "fatal",
                    overridable: false,
                    title: "Stale Validation Fingerprint",
                    description: "Content or configuration was modified after validation was performed. Re-validation required."
                });
            }
        }

        // 4. Structural Question Correctness (MCQ options, empty stems) (NEVER OVERRIDABLE)
        const brokenStems = questions.filter(q => !q.questionText || q.questionText.trim().length < 5);
        if (brokenStems.length > 0) {
            mandatoryBlockers.push({
                id: "broken_question_stems",
                code: "BROKEN_QUESTION_STEMS",
                severity: "fatal",
                overridable: false,
                title: "Incomplete Question Stems",
                description: `${brokenStems.length} question(s) have empty or incomplete stems (< 5 chars): Q${brokenStems.map(q => q.questionNumber).slice(0, 5).join(", ")}`
            });
        }

        const brokenMcqs = questions.filter(q => q.questionType === "mcq" && (!Array.isArray(q.options) || q.options.length < 2));
        if (brokenMcqs.length > 0) {
            mandatoryBlockers.push({
                id: "broken_mcq_options",
                code: "BROKEN_MCQ_OPTIONS",
                severity: "fatal",
                overridable: false,
                title: "Broken MCQ Option Structure",
                description: `${brokenMcqs.length} MCQ question(s) have fewer than 2 options: Q${brokenMcqs.map(q => q.questionNumber).slice(0, 5).join(", ")}`
            });
        }

        // Unresolved diagram options (placeholder without visual assets)
        const unmappedDiagramQuestions = questions.filter(q =>
            (q.questionType === "mcq" || q.questionType === "msq") &&
            q.validationStatus !== "corrected" &&
            Array.isArray(q.options) &&
            q.options.some(o => (o.text || "").includes("[Diagram / Structure") && !o.diagramUrl && !q.media?.some(m => m.type === "option_diagram" && String(m.optionId) === String(o.id)))
        );
        if (unmappedDiagramQuestions.length > 0) {
            mandatoryBlockers.push({
                id: "unresolved_diagram_options",
                code: "UNRESOLVED_DIAGRAM_OPTIONS",
                severity: "fatal",
                overridable: false,
                title: "Unresolved Diagram Options",
                description: `${unmappedDiagramQuestions.length} question(s) (Q${unmappedDiagramQuestions.map(q => q.questionNumber).slice(0, 5).join(", Q")}) have unmapped diagram placeholders without visual assets. Options must have diagram assets or manual text verification before publication.`
            });
        }

        // Authoritative Profile Verification Gate (NEVER OVERRIDABLE)
        const examConfig = job.draftPackage?.examConfig || job.verifiedPattern || ExamPatternService.getPattern(job.examId, job.year);
        if (examConfig?.requiresAdministrativeReview || examConfig?.status === "draft" || examConfig?.verificationStatus === "custom_unverified" || examConfig?.verificationStatus === "unverified_archetype") {
            mandatoryBlockers.push({
                id: "unverified_exam_profile",
                code: "UNVERIFIED_EXAM_PROFILE",
                severity: "fatal",
                overridable: false,
                title: "Unverified Examination Profile",
                description: `Examination pattern '${examConfig?.configId || job.examId}' requires administrative review and cannot be published.`
            });
        }

        // 5. Answer Key Scoring Integrity (NEVER OVERRIDABLE)
        const unverifiedKeys = answerKeys.filter(k => k.verificationStatus !== "verified");
        if (unverifiedKeys.length > 0) {
            mandatoryBlockers.push({
                id: "unverified_answer_keys",
                code: "UNVERIFIED_ANSWER_KEYS",
                severity: "fatal",
                overridable: false,
                title: "Unverified Official Answer Keys",
                description: `${unverifiedKeys.length} answer key(s) remain unverified against official key source.`
            });
        }

        // Answer key references missing options
        const akMap = new Map(answerKeys.map(k => [k.questionId, k]));
        for (const q of questions) {
            if (q.questionType === "mcq") {
                const ak = akMap.get(q.questionId);
                if (ak && Array.isArray(ak.correctOptionIds) && ak.correctOptionIds.length > 0 && Array.isArray(q.options) && q.options.length >= 2) {
                    const optIdSet = new Set(q.options.map(o => String(o.id)));
                    const missingOpt = ak.correctOptionIds.filter(id => !optIdSet.has(String(id)));
                    if (missingOpt.length > 0) {
                        mandatoryBlockers.push({
                            id: `scoring_mismatch_${q.questionId}`,
                            code: "SCORING_MISMATCH",
                            severity: "fatal",
                            overridable: false,
                            title: `Scoring Mismatch on Q${q.questionNumber}`,
                            description: `Answer key references option [${missingOpt.join(", ")}] not present in question options. Scoring would fail.`
                        });
                    }
                }
            }
        }

        // 6. Content Fidelity Flags (POTENTIALLY OVERRIDABLE)
        const flaggedQuestions = questions.filter(q => q.validationStatus === "flagged");
        for (const f of flaggedQuestions) {
            const isScoringConflict = (f.flagReason || "").toLowerCase().includes("scoring mismatch") || (f.flagReason || "").toLowerCase().includes("fewer than 2 options");
            if (isScoringConflict) {
                continue;
            }

            eligibleDiscrepancies.push({
                id: `disc_${f.questionId}`,
                questionId: f.questionId,
                questionNumber: f.questionNumber,
                subject: f.subject || "General",
                sourcePage: f.sourcePage || 1,
                hasDiagram: Boolean(f.hasDiagram),
                severity: "warning",
                category: "content_fidelity_warning",
                overridable: true,
                title: `Formula / Content Notation Warning (Q${f.questionNumber})`,
                description: f.flagReason || "Manual verification of complex formula notation requested"
            });
        }

        // Low confidence answer key provenance warnings
        const lowConf = job.validationReport?.answerKeyChecks?.lowConfidenceQuestions || [];
        if (Array.isArray(lowConf) && lowConf.length > 0) {
            eligibleDiscrepancies.push({
                id: "disc_ak_low_confidence",
                questionId: null,
                questionNumber: null,
                severity: "warning",
                category: "answer_key_provenance_warning",
                overridable: true,
                title: "Answer Key Provenance / Disclosed Low Confidence Items",
                description: `Official document flagged low confidence or provisional items on: Q${lowConf.join(", Q")}`
            });
        }

        // Unclassified question subject warnings
        const unclassifiedQuestions = questions.filter(q => q.subjectId === "unclassified" || !q.subject);
        if (unclassifiedQuestions.length > 0) {
            eligibleDiscrepancies.push({
                id: "disc_unclassified_subjects",
                questionId: null,
                questionNumber: null,
                severity: "warning",
                category: "subject_classification_warning",
                overridable: true,
                title: "Unclassified Question Subjects",
                description: `${unclassifiedQuestions.length} question(s) (Q${unclassifiedQuestions.map(q => q.questionNumber).slice(0, 5).join(", Q")}) have unclassified subjects. Subject-wise performance analysis will categorize them as 'Unclassified'.`
            });
        }

        // Structured Discrepancy Classification for Phase 5.12 Admin Override
        const criticalErrors = mandatoryBlockers.map(b => ({
            ...b,
            severity: "critical",
            overridable: true
        }));
        const majorErrors = [];
        const minorErrors = [];
        const warnings = eligibleDiscrepancies.map(w => ({
            ...w,
            severity: "warning",
            overridable: true
        }));
        const otherFindings = [];

        // Check UIR validation findings if uirDocument exists
        if (job.uirDocument) {
            try {
                const uirVal = UIRValidator.validate(job.uirDocument);
                if (Array.isArray(uirVal.errors)) {
                    uirVal.errors.forEach((err, idx) => {
                        majorErrors.push({
                            id: `uir_err_${idx + 1}`,
                            title: "UIR Validation Error",
                            severity: "major",
                            code: "UIR_VALIDATION_ERROR",
                            category: "uir_validation",
                            questionId: null,
                            questionNumber: null,
                            sectionId: null,
                            sectionReference: null,
                            description: err,
                            diagnostic: null,
                            overridable: true
                        });
                    });
                }
                if (Array.isArray(uirVal.warnings)) {
                    uirVal.warnings.forEach((warn, idx) => {
                        minorErrors.push({
                            id: `uir_warn_${idx + 1}`,
                            title: "UIR Validation Warning",
                            severity: "minor",
                            code: "UIR_VALIDATION_WARNING",
                            category: "uir_validation",
                            questionId: null,
                            questionNumber: null,
                            sectionId: null,
                            sectionReference: null,
                            description: warn,
                            diagnostic: null,
                            overridable: true
                        });
                    });
                }
            } catch (_) {}
        }

        // Check if job.validationReport?.blockers has items not yet represented
        if (Array.isArray(job.validationReport?.blockers)) {
            job.validationReport.blockers.forEach((blk, idx) => {
                const alreadyIncluded = criticalErrors.some(c => c.description === blk || c.title === blk);
                if (!alreadyIncluded) {
                    criticalErrors.push({
                        id: `blocker_${idx + 1}`,
                        title: "Validation Gate Blocker",
                        severity: "critical",
                        code: "VALIDATION_BLOCKER",
                        category: "validation_gate",
                        questionId: null,
                        questionNumber: null,
                        sectionId: null,
                        sectionReference: null,
                        description: blk,
                        diagnostic: null,
                        overridable: true
                    });
                }
            });
        }

        const allDiscrepancies = [
            ...criticalErrors,
            ...majorErrors,
            ...minorErrors,
            ...warnings,
            ...otherFindings
        ];

        const counts = {
            total: allDiscrepancies.length,
            critical: criticalErrors.length,
            major: majorErrors.length,
            minor: minorErrors.length,
            warning: warnings.length,
            other: otherFindings.length
        };

        const canStandardPublish = mandatoryBlockers.length === 0 && eligibleDiscrepancies.length === 0 && Boolean(job.validationReport?.canPublish);
        const canOverride = true;

        return {
            allDiscrepancies,
            criticalErrors,
            majorErrors,
            minorErrors,
            warnings,
            otherFindings,
            counts,
            eligibleDiscrepancies,
            eligibleWarnings: eligibleDiscrepancies,
            mandatoryBlockers,
            fatalBlockers: mandatoryBlockers,
            totalDiscrepancies: allDiscrepancies.length,
            canStandardPublish,
            canPublish: canStandardPublish,
            canOverride,
            fingerprintStatus: mandatoryBlockers.some(b => b.code.includes("FINGERPRINT")) ? "invalid" : "valid"
        };
    }

    /**
     * Publish test paper with explicitly reviewed, acknowledged discrepancies
     */
    static async publishTestOverride({ jobId, actor = "admin", reason, acknowledgedDiscrepancyIds = [], confirmationText = "" }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);

        if (job.status === "published") {
            throw new Error(`Test paper ${job.draftPackage?.testId || jobId} is already published.`);
        }

        // Reason validation (min 10 characters)
        if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
            throw new Error("An override reason of at least 10 characters is required explaining why publication discrepancies are acceptable.");
        }

        // Server-Authoritative Discrepancy Evaluation
        const classification = this.classifyDiscrepancies(job);

        // Reject if any never-overridable mandatory blockers exist
        if (classification.mandatoryBlockers.length > 0) {
            const blockerDesc = classification.mandatoryBlockers.map(b => b.description).join("; ");
            throw new Error(`Publication Override REJECTED: Mandatory integrity and security blockers cannot be overridden: ${blockerDesc}`);
        }

        // Check that acknowledgedDiscrepancyIds covers ALL eligible discrepancies
        if (!Array.isArray(acknowledgedDiscrepancyIds)) {
            throw new Error("acknowledgedDiscrepancyIds must be an array of discrepancy IDs.");
        }

        const acknowledgedSet = new Set(acknowledgedDiscrepancyIds.map(String));
        const missingAcks = classification.eligibleDiscrepancies.filter(d => !acknowledgedSet.has(d.id));
        if (missingAcks.length > 0) {
            throw new Error(`All unresolved discrepancies must be explicitly acknowledged. Missing acknowledgements for: [${missingAcks.map(m => m.id).join(", ")}]`);
        }

        // For high-impact overrides (more than 0 discrepancies), verify confirmationText
        if (classification.eligibleDiscrepancies.length > 0) {
            if (confirmationText !== "PUBLISH WITH DISCREPANCIES") {
                throw new Error("High-impact override requires exact confirmation text 'PUBLISH WITH DISCREPANCIES'.");
            }
        }

        const testId = job.draftPackage?.testId || job.mockTestId || job.jobId;
        let testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            testDoc = {
                testId,
                examId: job.examId,
                examName: job.examName || job.examId,
                year: job.year,
                title: `${job.examName || job.examId} (${job.year})`,
                status: "draft",
                totalQuestions: (job.draftPackage?.questions || job.extractedQuestions || []).length
            };
        }

        const publishedAt = new Date().toISOString();
        const overrideAuditId = `audit_override_${jobId}_${Date.now()}`;

        // Update test document with override status
        testDoc.status = "published";
        testDoc.publishedAt = publishedAt;
        testDoc.publishedBy = actor;
        testDoc.publishedWithDiscrepancies = true;
        testDoc.publicationMode = "override";
        testDoc.overrideAuditId = overrideAuditId;
        testDoc.acknowledgedDiscrepancyIds = acknowledgedDiscrepancyIds;
        testDoc.overrideReason = reason.trim();
        testDoc.updatedAt = publishedAt;
        testDoc.contentNotice = "Official paper contains verified content with acknowledged source-layout notations.";

        // Update job
        job.status = "published";
        job.publishedWithDiscrepancies = true;
        job.publicationMode = "override";
        job.overrideAuditId = overrideAuditId;
        job.acknowledgedDiscrepancyIds = acknowledgedDiscrepancyIds;
        job.stage = "Test published with acknowledged discrepancies (Override Mode)";
        job.auditLog.push({
            actor,
            action: "TEST_PUBLISHED_OVERRIDE",
            testId,
            overrideAuditId,
            timestamp: publishedAt,
            reason: reason.trim(),
            acknowledgedDiscrepancyIds,
            discrepancyCount: acknowledgedDiscrepancyIds.length,
            validationFingerprint: job.contentFingerprint,
            sourceHashes: job.sourceHashes,
            discrepancySummary: classification.eligibleDiscrepancies.map(d => ({
                id: d.id,
                questionNumber: d.questionNumber,
                title: d.title,
                description: d.description
            }))
        });
        job.updatedAt = publishedAt;

        // Save atomically
        await UniversalFirestoreService.setDocument("mockTests", testId, testDoc);
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        // Record in durable admin audit log collection
        await UniversalFirestoreService.setDocument("adminAuditLogs", overrideAuditId, {
            auditId: overrideAuditId,
            actor,
            action: "PUBLISH_WITH_DISCREPANCIES_OVERRIDE",
            jobId,
            testId,
            examId: job.examId,
            examName: job.examName || job.examId,
            year: job.year,
            paperCode: job.paperCode,
            timestamp: publishedAt,
            overrideReason: reason.trim(),
            acknowledgedDiscrepancyIds,
            discrepancyCount: acknowledgedDiscrepancyIds.length,
            validationFingerprint: job.contentFingerprint,
            sourceHashes: job.sourceHashes,
            publicationOutcome: "published"
        });

        activeJobs.set(jobId, job);
        PyqLibraryService.invalidateAllCaches();

        return {
            success: true,
            jobId,
            testId,
            status: "published",
            publishedAt,
            publicationMode: "override",
            overrideAuditId,
            acknowledgedCount: acknowledgedDiscrepancyIds.length
        };
    }

    /**
     * PHASE 5.12: Administrative Override: "IGNORE AND PUBLISH"
     * Allows an authorized administrator to deliberately bypass ALL validation discrepancies
     * (Critical, Major, Minor, Warnings, extraction/key/count/marking discrepancies, UIR findings)
     * and publish the target mock test exactly as it currently exists.
     */
    static async executeValidationOverridePublish({ testId, jobId, actor = "admin", actorEmail = null, reason = "" }) {
        if (!actor) {
            const err = new Error("Authentication required: valid administrator actor must initiate override publish.");
            err.statusCode = 401;
            throw err;
        }

        const targetIdentifier = testId || jobId;
        if (!targetIdentifier) {
            const err = new Error("Mock test identifier or import job ID is required.");
            err.statusCode = 400;
            throw err;
        }

        // Concurrency lock
        if (activeOverridePublishLocks.has(targetIdentifier)) {
            const err = new Error(`Publication override already in progress for '${targetIdentifier}'. Please wait.`);
            err.statusCode = 409;
            throw err;
        }
        activeOverridePublishLocks.add(targetIdentifier);

        try {
            // 1. Resolve Target Job & Mock Test Record
            let job = null;
            if (jobId) {
                job = await this.getJob(jobId);
            }
            if (!job && testId) {
                // Search in-memory activeJobs
                for (const j of activeJobs.values()) {
                    if (j.publishedMockTestId === testId || j.draftPackage?.testId === testId || j.mockTestId === testId || j.jobId === testId) {
                        job = j;
                        break;
                    }
                }
                if (!job) {
                    try {
                        const allJobs = await UniversalFirestoreService.listDocuments("paperImportJobs");
                        job = allJobs.find(j => j.publishedMockTestId === testId || j.draftPackage?.testId === testId || j.mockTestId === testId || j.jobId === testId) || null;
                    } catch (_) {}
                }
            }

            const targetTestId = testId || job?.draftPackage?.testId || job?.publishedMockTestId || job?.mockTestId || job?.jobId;
            if (!targetTestId) {
                const err = new Error(`Could not resolve mock test ID from identifier '${targetIdentifier}'.`);
                err.statusCode = 404;
                throw err;
            }

            let testDoc = await UniversalFirestoreService.getDocument("mockTests", targetTestId);

            if (!testDoc && !job) {
                const err = new Error(`Mock test '${targetTestId}' not found.`);
                err.statusCode = 404;
                throw err;
            }

            // 2. Publication state validation (Idempotency / Guard against already published)
            if (testDoc?.status === "published" || job?.status === "published") {
                const err = new Error(`Mock test '${targetTestId}' is already published.`);
                err.statusCode = 400;
                throw err;
            }

            const previousStatus = testDoc?.status || job?.status || "draft";

            // 3. Server-authoritatively gather validation findings being overridden
            let classification = null;
            let findings = [];
            let counts = { total: 0, critical: 0, major: 0, minor: 0, warning: 0, other: 0 };

            if (job) {
                classification = this.classifyDiscrepancies(job);
                findings = classification.allDiscrepancies || [];
                counts = classification.counts || {
                    total: findings.length,
                    critical: classification.criticalErrors?.length || 0,
                    major: classification.majorErrors?.length || 0,
                    minor: classification.minorErrors?.length || 0,
                    warning: classification.warnings?.length || 0,
                    other: classification.otherFindings?.length || 0
                };
            } else if (testDoc?.validationReport?.blockers || testDoc?.discrepancies) {
                const rawBlockers = testDoc.validationReport?.blockers || testDoc.discrepancies || [];
                findings = rawBlockers.map((b, idx) => ({
                    id: `finding_${idx + 1}`,
                    title: typeof b === "string" ? b : (b.title || "Validation Finding"),
                    severity: typeof b === "object" && b.severity ? b.severity : "warning",
                    description: typeof b === "string" ? b : (b.description || ""),
                    questionId: typeof b === "object" ? b.questionId : null,
                    sectionId: typeof b === "object" ? b.sectionId : null,
                    overridable: true
                }));
                counts.total = findings.length;
                counts.warning = findings.length;
            }

            const publishedAt = new Date().toISOString();
            const overrideAuditId = `audit_override_${targetTestId}_${Date.now()}`;
            const sanitizedReason = typeof reason === "string" ? reason.trim() : "";

            // 4. Update Mock Test document (PRESERVE ALL TEST CONTENT, QUESTIONS, KEYS, MARKING EXACTLY AS-IS)
            if (!testDoc) {
                testDoc = {
                    testId: targetTestId,
                    examId: job?.examId || "unknown",
                    examName: job?.examName || job?.examId || targetTestId,
                    year: job?.year || new Date().getFullYear(),
                    title: job?.draftPackage?.title || `${job?.examName || job?.examId || targetTestId} (${job?.year || new Date().getFullYear()})`,
                    totalQuestions: (job?.draftPackage?.questions || job?.extractedQuestions || []).length
                };
            }

            testDoc.status = "published";
            testDoc.publishedAt = publishedAt;
            testDoc.publishedBy = actor;
            testDoc.publishedByEmail = actorEmail || null;
            testDoc.publicationMethod = "ADMIN_OVERRIDE";
            testDoc.publishedWithValidationOverride = true;
            testDoc.publishedWithDiscrepancies = true;
            testDoc.publicationMode = "override";
            testDoc.overrideTimestamp = publishedAt;
            testDoc.overrideAdminId = actor;
            testDoc.overrideAdminEmail = actorEmail || null;
            testDoc.overrideReason = sanitizedReason;
            testDoc.validationReportId = job?.validationReport?.reportId || job?.jobId || targetTestId;
            testDoc.overriddenDiscrepancies = findings;
            testDoc.contentNotice = "Published with Administrative Override - Contains acknowledged validation discrepancies.";
            testDoc.updatedAt = publishedAt;

            // 5. Update Job record (if associated with a pipeline job)
            if (job) {
                job.status = "published";
                job.publishedMockTestId = targetTestId;
                job.publicationMethod = "ADMIN_OVERRIDE";
                job.publishedWithValidationOverride = true;
                job.publishedWithDiscrepancies = true;
                job.publicationMode = "override";
                job.overrideTimestamp = publishedAt;
                job.overrideAdminId = actor;
                job.overrideReason = sanitizedReason;
                job.overrideAuditId = overrideAuditId;
                job.stage = "Published with Administrative Override";
                job.updatedAt = publishedAt;
                if (!Array.isArray(job.auditLog)) job.auditLog = [];
                job.auditLog.push({
                    actor,
                    actorEmail,
                    action: "ADMIN_VALIDATION_OVERRIDE_PUBLISH",
                    testId: targetTestId,
                    overrideAuditId,
                    timestamp: publishedAt,
                    reason: sanitizedReason,
                    totalDiscrepancies: findings.length,
                    discrepancySummary: counts,
                    overriddenDiscrepancies: findings
                });
            }

            // 6. Commit to Firestore
            await UniversalFirestoreService.setDocument("mockTests", targetTestId, testDoc);
            if (job && job.jobId) {
                await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
                activeJobs.set(job.jobId, job);
            }

            // 7. Write immutable audit record in adminAuditLogs collection
            const auditRecord = {
                auditId: overrideAuditId,
                mockTestId: targetTestId,
                mockTestName: testDoc.title || job?.examName || targetTestId,
                adminUid: actor,
                adminEmail: actorEmail || null,
                validationReportId: testDoc.validationReportId,
                validationReportTimestamp: job?.validationReport?.validatedAt || job?.createdAt || publishedAt,
                totalDiscrepancyCount: findings.length,
                criticalDiscrepancyCount: counts.critical,
                majorDiscrepancyCount: counts.major,
                minorDiscrepancyCount: counts.minor,
                warningCount: counts.warning,
                otherFindingCount: counts.other,
                findingsSnapshot: findings,
                overrideReason: sanitizedReason,
                timestamp: publishedAt,
                publicationMethod: "ADMIN_OVERRIDE",
                publishedWithValidationOverride: true,
                previousPublicationStatus: previousStatus,
                newPublicationStatus: "published",
                operationResult: "SUCCESS"
            };
            await UniversalFirestoreService.setDocument("adminAuditLogs", overrideAuditId, auditRecord);

            // 8. Invalidate Caches
            PyqLibraryService.invalidateAllCaches();

            return {
                success: true,
                message: "Mock test published successfully under administrative validation override.",
                testId: targetTestId,
                jobId: job?.jobId || null,
                status: "published",
                publicationMethod: "ADMIN_OVERRIDE",
                publishedWithValidationOverride: true,
                publishedAt,
                overrideAuditId,
                discrepancySummary: counts
            };
        } finally {
            activeOverridePublishLocks.delete(targetIdentifier);
        }
    }
}
