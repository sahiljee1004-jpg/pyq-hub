import crypto from "node:crypto";
import fs from "node:fs";
import { QuestionPaperParser } from "./questionPaperParser.js";
import { AnswerKeyParser } from "./answerKeyParser.js";
import { PaperFormatParser } from "./paperFormatParser.js";
import { IngestionValidator } from "./ingestionValidator.js";

const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-

export class UniversalDocumentIngestionService {

    /**
     * Ingest and parse all three documents concurrently or sequentially
     * 
     * @param {object} inputs
     * @param {Buffer|string} inputs.questionPaper - PDF buffer or raw text of Question Paper
     * @param {Buffer|string} inputs.answerKey - PDF buffer or raw text of Answer Key
     * @param {Buffer|string} inputs.paperFormat - PDF buffer or raw text of Paper Format document
     * @param {object} options
     * @returns {Promise<object>} Consolidated raw ingestion manifest
     */
    static async ingestDocuments({ questionPaper, answerKey, paperFormat }, options = {}) {
        const jobId = options.jobId || `ingest_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const startedAt = new Date().toISOString();

        // 1. Resolve and validate input buffers/strings
        const qpInput = this.resolveInput(questionPaper, "questionPaper");
        const akInput = this.resolveInput(answerKey, "answerKey");
        const pfInput = this.resolveInput(paperFormat, "paperFormat");

        // 2. Compute cryptographic hashes (SHA-256)
        const qpHash = this.computeSha256(qpInput);
        const akHash = this.computeSha256(akInput);
        const pfHash = this.computeSha256(pfInput);

        // 3. Concurrent parsing of the three documents
        const [qpExtraction, akExtraction, pfExtraction] = await Promise.all([
            QuestionPaperParser.parse(qpInput, options),
            AnswerKeyParser.parse(akInput, options),
            PaperFormatParser.parse(pfInput, options)
        ]);

        // 4. Evidence Reconciliation & Three-Document Cross Verification (Phase 4.5)
        let reconciliation = null;
        let questionReconciliation = null;
        try {
            const { EvidenceReconciliationService } = await import("../documentUnderstanding/evidenceReconciliationService.js");
            const recOptions = {
                ...options,
                useAiReasoning: options.enableAiReasoning === true
            };
            reconciliation = await EvidenceReconciliationService.crossVerifyThreeDocuments({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction,
                options: recOptions
            });
            if (qpExtraction.questions && qpExtraction.questions.length > 0) {
                questionReconciliation = await EvidenceReconciliationService.reconcileAllQuestions({
                    questions: qpExtraction.questions,
                    answerKey: akExtraction,
                    examPattern: pfExtraction,
                    options: recOptions
                });
            }
        } catch (e) {
            // Non-blocking fallback
        }

        // 5. Syntactic & structural validation (Ingestion completion gate)
        const validation = IngestionValidator.validate({
            questionPaperExtraction: qpExtraction,
            answerKeyExtraction: akExtraction,
            paperFormatExtraction: pfExtraction
        });

        // 6. Strict publication readiness validation gate (Phase 2.3)
        const publicationValidation = IngestionValidator.validatePublication({
            questionPaperExtraction: qpExtraction,
            answerKeyExtraction: akExtraction,
            paperFormatExtraction: pfExtraction,
            options
        });

        const completedAt = new Date().toISOString();

        return {
            ingestionJobId: jobId,
            startedAt,
            completedAt,
            documentProvenance: {
                questionPaper: {
                    sha256: qpHash,
                    isBuffer: Buffer.isBuffer(qpInput),
                    sizeBytes: Buffer.isBuffer(qpInput) ? qpInput.length : Buffer.byteLength(qpInput, "utf8"),
                    isScanned: qpExtraction.isScanned,
                    questionCount: qpExtraction.questions ? qpExtraction.questions.length : 0,
                    sectionCount: qpExtraction.sections ? qpExtraction.sections.length : 0
                },
                answerKey: {
                    sha256: akHash,
                    isBuffer: Buffer.isBuffer(akInput),
                    sizeBytes: Buffer.isBuffer(akInput) ? akInput.length : Buffer.byteLength(akInput, "utf8"),
                    answerCount: akExtraction.answers ? akExtraction.answers.length : 0,
                    paperSeries: akExtraction.header?.paperSeries?.value || null,
                    paperCode: akExtraction.header?.paperCode?.value || null
                },
                paperFormat: {
                    sha256: pfHash,
                    isBuffer: Buffer.isBuffer(pfInput),
                    sizeBytes: Buffer.isBuffer(pfInput) ? pfInput.length : Buffer.byteLength(pfInput, "utf8"),
                    declaredTotalQuestions: pfExtraction.totalQuestions?.value ?? null,
                    declaredMaxMarks: pfExtraction.maximumMarks?.value ?? null,
                    declaredDurationSeconds: pfExtraction.durationSeconds?.value ?? null
                }
            },
            extractions: {
                questionPaper: qpExtraction,
                answerKey: akExtraction,
                paperFormat: pfExtraction
            },
            reconciliation,
            questionReconciliation,
            validation,
            publicationValidation
        };
    }

    /**
     * Resolves and verifies input (buffer, string, or file path)
     */
    static resolveInput(input, documentName) {
        if (!input) {
            throw new Error(`[UniversalDocumentIngestionService] Missing required document: ${documentName}`);
        }

        if (Buffer.isBuffer(input)) {
            if (input.length > MAX_DOCUMENT_SIZE_BYTES) {
                throw new Error(`[UniversalDocumentIngestionService] Document ${documentName} exceeds 50MB size limit.`);
            }
            // Check PDF magic byte if it's a binary PDF buffer
            if (input.length >= 5 && input.slice(0, 5).equals(PDF_MAGIC_BYTES)) {
                return input;
            }
            // Could be raw text buffer
            return input;
        }

        if (typeof input === "string") {
            // Check if string is a local file path
            if (fs.existsSync(input)) {
                const stat = fs.statSync(input);
                if (stat.size > MAX_DOCUMENT_SIZE_BYTES) {
                    throw new Error(`[UniversalDocumentIngestionService] File ${input} exceeds 50MB size limit.`);
                }
                return fs.readFileSync(input);
            }
            return input; // Raw text content
        }

        if (Array.isArray(input)) {
            return input; // Structured page array
        }

        throw new Error(`[UniversalDocumentIngestionService] Unsupported input type for ${documentName}`);
    }

    /**
     * Computes SHA-256 digest of input
     */
    static computeSha256(input) {
        const hash = crypto.createHash("sha256");
        if (Buffer.isBuffer(input)) {
            hash.update(input);
        } else if (typeof input === "string") {
            hash.update(input, "utf8");
        } else if (Array.isArray(input)) {
            hash.update(JSON.stringify(input), "utf8");
        }
        return hash.digest("hex");
    }
}

