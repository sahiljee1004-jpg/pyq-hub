# Master Audit: Existing Mock Test Creation & Execution Pipeline

**Audit Date:** 2026-11-14T02:45:00+05:30  
**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Purpose:** Comprehensive baseline audit of the existing mock test creation, scoring, ingestion, and student execution systems to guide the transformation into a fully document-driven, exam-agnostic pipeline.

---

## 1. Executive Summary

The current VidyarthiAstra platform contains the foundations of a universal testing architecture:
1. An exact rational arithmetic library (`Rational` using native BigInts) that eliminates floating-point drift.
2. A declarative 4-level scoring engine (`UniversalScoringEngine`) capable of evaluating MCQs, MSQs, and Numerical questions based on exam profiles.
3. An administrative import pipeline (`ImportJobPipelineService`) that accepts three source documents (Question Paper, Answer Key, Exam Pattern) and calculates SHA-256 cryptographic hashes.
4. An answer key reconciliation service with Scored-Test gating.

However, **the mock test generation process is not currently document-driven or exam-agnostic**. The system relies on:
- Hardcoded exam-name regexes and branches (`NEET`, `JEE`, `UPSC`, `BPSC`, `GATE`, `NDA`, `SSC`, `Banking`).
- Synthetic fallback defaults (unconditionally injecting NEET UG 2024 structure, question counts, or JEE Main sections when documents lack recognized signatures).
- In-memory, hardcoded exam profiles (`AUDITED_EXAM_PROFILES` in `ExamProfileRegistry.js`) with no dynamic persistence or admin configuration generator.
- Rudimentary pattern document parsing (extracting only basic question and mark counts via simple regex, completely ignoring section layouts, question types, and optional attempt rules).
- Frontend UI that lacks section-aware navigation and only supports three question types (MCQ, MSQ, Numerical).

To onboard a new examination today, developers must write exam-specific JavaScript in at least four services. This audit catalogues every component, conditional branch, gap, and reusable asset across the codebase.

---

## 2. In-Depth Component Analysis

### 2.1 Universal Exam Profile Registry (`server/services/admin/examProfileRegistry.js`)

#### Architecture & Strengths
- Declares a comprehensive schema specification (v2.8) for examination profiles.
- Validates profile structure via `validateProfileSchema`:
  - Identity: `profileId`, `examId`, `examName`, `year`, `patternVersion`, `verificationStatus`, `isOfficial`.
  - Global Parameters: `totalQuestions`, `requiredQuestionsToAttempt`, `maximumMarks`, `durationSeconds`, `negativeMarkingEnabled`, `allowedOptionCounts`.
  - Policies: `optionalQuestionPolicy` (`none`, `first_k_attempted`, `candidate_selected`), `droppedQuestionPolicy` (`full_marks`, `pro_rata`, `attempted_only`, `zero_marks`).
  - Section Hierarchy: `sections` array with contiguous question ranges (`startQuestion` to `endQuestion`), `questionCount`, `requiredCount`, `questionType`, and `markingScheme` (`correct`, `incorrect`, `unanswered`).
  - Provenance: `sourceProvenance` with document name and citations.

#### Identified Defects & Limitations
1. **Hardcoded In-Memory Catalog:**
   All 10 audited profiles are hardcoded in an internal object constant (`AUDITED_EXAM_PROFILES`, lines 55–1240). Profiles cannot be created, imported, or updated without modifying repository source code.
2. **Missing Configuration Persistence:**
   There is no database backing (`examProfiles` collection in Firestore). Dynamic profiles registered via `registerProfile()` exist only in Node.js process memory and are lost on restart.
3. **Fail-Closed Rejection of New Exams:**
   `ExamProfileRegistry.findProfile(cleanExam, numYear)` throws `UNRECOGNIZED_EXAM_PATTERN` for any exam not in the 10 hardcoded profiles, immediately blocking scoring unless unsafe bypass flags are provided.
4. **Coarse Question Types:**
   Section question types are constrained to `["mcq", "msq", "numerical", "descriptive", "mixed"]`. Missing granular types: `assertion_reason`, `match_following`, `matrix_match`, `fill_in_the_blanks`, `passage_comprehension`.

---

### 2.2 Scoring Engine & Rational Arithmetic

#### Files:
- [server/services/scoring/rational.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/scoring/rational.js)
- [server/services/scoring/universalScoringEngine.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/scoring/universalScoringEngine.js)
- [server/services/scoring/legacyScoringAdapter.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/scoring/legacyScoringAdapter.js)
- [server/services/mockTestScoringService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/mockTestScoringService.js)

#### Architecture & Strengths
1. **`Rational` Exact Arithmetic:**
   - Arbitrary-precision exact fractions using native `BigInt` (`num / den`).
   - Handles positive, negative, and recurring fractional marks (e.g. `1/3`, `2/3`, `-0.3333`) without IEEE-754 floating-point drift.
   - Configurable rounding modes: `round_half_up`, `round_half_even`, `truncate`, `floor`, `ceil`.
2. **`UniversalScoringEngine` 4-Level Hierarchy:**
   - Level 4 (Highest): Explicit question or answer-key override (`key.marksAwarded`, `key.marksDeducted`).
   - Level 3: Section/profile question-type rule (`section.questionTypeRules[type]`).
   - Level 2: Section marking scheme (`section.markingScheme`).
   - Level 1: Exam default marking scheme (`profile.markingScheme`).
3. **Multi-Policy Support:**
   - Dropped questions: `full_marks`, `pro_rata`, `attempted_only`, `zero_marks`.
   - Optional questions: `first_k_attempted` (evaluates only the first $K$ attempted questions in a section), `candidate_selected`.
   - Numerical tolerance: matches absolute tolerance or integer boundaries.

#### Identified Defects & Exam-Specific Couplings
1. **`mockTestScoringService.js` Hardcoded Branches:**
   Lines 147–185 contain explicit exam-name checks:
   ```javascript
   const isGateExam = examId.includes("gate");
   const isJeeExam = examId.includes("jee");
   const isBpscExam = examId.includes("bpsc");
   const isUpscExam = examId.includes("upsc");
   const isNeetExam = examId.includes("neet");
   const isSscExam = examId.includes("ssc");
   ```
   These branches hardcode specific marks per question, GATE MSQ zero penalty rules, and BPSC 1/3 deductions.
2. **Coupling in `LegacyScoringAdapter`:**
   Retains identical hardcoded branches for backward compatibility with Schema v1 attempts. (This must be preserved for historical records, but never invoked for newly generated tests).

---

### 2.3 Document Ingestion & Extraction Services

#### Files:
- [server/services/admin/importJobPipelineService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/importJobPipelineService.js)
- [server/services/admin/metadataExtractionService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/metadataExtractionService.js)
- [server/services/admin/examPatternService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/examPatternService.js)
- [server/services/admin/questionNormalizationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/questionNormalizationService.js)
- [server/services/admin/answerKeyReconciliationService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/answerKeyReconciliationService.js)
- [server/services/admin/diagramExtractionService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/admin/diagramExtractionService.js)

#### Pipeline Stages & Audit Findings

| Stage | Responsible Component | Current Implementation | Critical Defect / Limitation |
| :--- | :--- | :--- | :--- |
| **1. Source Ingestion** | `StorageVaultService`, `ImportJobPipelineService` | Accepts 3 PDFs (`questionPaper`, `answerKey`, `examPattern`), computes SHA-256 hashes, stores in local vault. | Only accepts PDF buffers. Does not support DOCX, OCR images, or multi-part uploads. |
| **2. Metadata Extraction** | `MetadataExtractionService` | Parses text streams via `pdf-parse`. Extracts booklet code, series, year. | **Severe Hardcoding:** Lines 370–448 inject hardcoded JEE Main (75 Q, 300 marks, 6 sections) or UPSC (100 Q, 200 marks) or NEET (200 Q, 720 marks) schemas if the exam name matches. Unrecognized exams receive empty sections or default to NEET. |
| **3. Pattern Configuration** | `ExamPatternService` | Resolves exam name via regex to recognized IDs (`neet-ug`, `jee-main`, etc.). Queries `ExamProfileRegistry`. | **Severe Hardcoding:** Only recognizes 8 hardcoded exam families. Does not parse section definitions, optional rules, or negative marking from the uploaded `examPattern` document. |
| **4. Question Extraction** | `QuestionNormalizationService` | Sorts PDF text items by `(x, y)` coordinates. Reassembles fractions, detects horizontal bands, extracts diagrams via canvas/pdfjs. | **Coupling & Fragility:** Line 120 hardcodes JEE numerical question ranges (21–25, 46–50, 71–75). Line 30 hardcodes BPSC running footers. Does not extract comprehension passages or match-following tables. |
| **5. Answer Key Reconciliation** | `AnswerKeyReconciliationService` | Tokenizes answer key PDF. Matches Q1..QN answers. Validates booklet series/code parity. | **Gaps:** Assumes sequential 1..N or standard section numbering. Does not support question-paper shuffling, alternate code permutations, or range-based numerical key answers (`[2.5, 2.7]`). |
| **6. Gating & Validation** | `ImportJobPipelineService` | Enforces Scored-Test Gate (`gatePassed`), booklet parity gate, content fidelity checks, and validation fingerprinting. | High quality gating logic, but gates evaluate against hardcoded profiles rather than document-derived rules. |
| **7. Publishing** | `ImportJobPipelineService`, `UniversalFirestoreService` | Writes `mockTests`, `mockQuestions`, `mockAnswerKeys`. Strips answers from test documents. | Concurrency safe and properly isolated. |

---

### 2.4 Student Execution & Frontend Interface

#### Files:
- [server/routes/mockTests.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/routes/mockTests.js)
- [server/services/mockTestService.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/server/services/mockTestService.js)
- [www/mock-test.html](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/www/mock-test.html)
- [www/js/mock-test.js](file:///C:/Users/RUPENDRA/Documents/VidyarthiAstra-current/www/js/mock-test.js)

#### Audit Findings:
1. **Missing Section UI in Test Interface:**
   - While the backend and data schema support sections, `www/js/mock-test.js` flattens all questions into a single numerical index `0..questions.length - 1`.
   - The student has **zero visual section tabs**, no section headers, no section-specific time warnings, and no optional attempt counters during the test.
2. **Limited Question Type Renderers:**
   - `mock-test.js` lines 610–697 implement renderers for:
     - `numerical` (text box for integer/decimal)
     - `msq` (checkbox list for multiple choices)
     - `mcq` (radio button list for single choice)
   - The UI completely lacks renderers for:
     - `fill_in_the_blanks` (inline text inputs)
     - `match_following` (column A to column B matching grid)
     - `assertion_reason` (structured Assertion / Reason cards)
     - `passage_comprehension` (split pane reading passage with linked questions)
     - `descriptive` (rich text area / file upload for manual review)
3. **Autosave & Submission:**
   - Robust optimistic concurrency check (`expectedUpdateTime` / HTTP 412).
   - Server-authoritative scoring: client-submitted scores are strictly discarded.

---

## 3. Comprehensive Inventory of Exam-Specific Conditional Statements

The following table details every exam-specific conditional statement and hardcoded rule in the codebase that must be removed or generalized:

| File | Lines | Hardcoded Exam Condition / Logic | Impact / Violation |
| :--- | :--- | :--- | :--- |
| `server/services/admin/metadataExtractionService.js` | 360–375 | `if (/neet/i.test(extracted.examId.value))` -> Injects NEET UG 720 marks, 200 Qs, 4 subjects. | Forces NEET structure onto any exam containing "neet". |
| `server/services/admin/metadataExtractionService.js` | 375–405 | `else if (/jee/i.test(extracted.examId.value))` -> Injects JEE Main 75 Qs, 300 marks, 6 sections (Math A/B, Phys A/B, Chem A/B). | Hardcodes JEE Main 2024 structure. Breaks for JEE 2020 or JEE Advanced. |
| `server/services/admin/metadataExtractionService.js` | 406–448 | `else if (/upsc/i.test(extracted.examId.value))` -> Injects UPSC 100 Qs, 200 marks, -2/3 penalty, 120 mins. | Hardcodes UPSC Prelims Paper 1. Fails for CSAT Paper 2 (80 Qs, 2.5 marks). |
| `server/services/admin/examPatternService.js` | 47–116 | Regex checks: `neet`, `jee-main`, `jee-advanced`, `gate`, `nda`, `cuet`, `bpsc`, `upsc`, `ssc-cgl`, `banking-ibps-po`. | New exams cannot be resolved without code changes. |
| `server/services/admin/examPatternService.js` | 155–170 | `if (cleanExam.includes("neet") && numYear === 2024)` -> Injects 180 vs 200 question sample configs. | Hardcoded sample test rules. |
| `server/services/admin/questionNormalizationService.js` | 28–32 | `PREVIOUS YEAR QUESTIONS`, `19-C/FI/CC/PT-2023`, `BPSC` running footers. | Exam-specific watermarks hardcoded in parser. |
| `server/services/admin/questionNormalizationService.js` | 120–125 | `if (cleanExam.includes("jee")) { if (q >= 21 && q <= 25 ...) return true; }` | Hardcodes numerical question indices for JEE. |
| `server/services/mockTestScoringService.js` | 147–185 | `isGateExam`, `isJeeExam`, `isBpscExam`, `isUpscExam`, `isNeetExam`, `isSscExam` branches. | Exam-specific marks (+1, +2, +4) and negative penalties (-0.3333, -0.6667, -1, 0) hardcoded in scoring service. |
| `server/services/admin/importJobPipelineService.js` | 147–150 | `PRODUCTION_EXAM_IDS = new Set(["neet-ug", "jee-main", "upsc-prelims", "gate-cs", "nda", "cuet-ug"])`. | Hardcoded production exam allowlist. |
| `server/services/admin/universalFirestoreService.js` | 780–799 | Legacy path compatibility write: `exams/${examId}/years/${year}/papers/...`. | Hardcodes NTA-style legacy hierarchy. |

---

## 4. Reusable Architectural Components

| Component | File Location | Architectural Capability | Reuse Strategy |
| :--- | :--- | :--- | :--- |
| **`Rational`** | `server/services/scoring/rational.js` | Exact BigInt fractional arithmetic, GCD reduction, recurring fraction detection. | **100% Reused verbatim** for all scoring computations. |
| **`UniversalScoringEngine`** | `server/services/scoring/universalScoringEngine.js` | 4-level scoring hierarchy, optional question policies (`first_k_attempted`, `candidate_selected`), dropped question policies. | **Reused as the core evaluation engine**. Extend to support new question types and partial marking policies. |
| **`StorageVaultService`** | `server/services/admin/storageVaultService.js` | Cryptographic SHA-256 document hashing, isolated vault storage, content retrieval. | **Reused as the source document vault**. Extend to accept multi-format documents (DOCX, images). |
| **`DiagramExtractionService`** | `server/services/admin/diagramExtractionService.js` | PDF image/vector diagram clipping, bounding box calculation, asset storage. | **Reused** for question and option diagram extraction. |
| **`AnswerKeyReconciliationService`** | `server/services/admin/answerKeyReconciliationService.js` | Multi-strategy token parsing, Scored-Test Gate enforcement, conflict detection. | **Reused & Generalized**: Decouple from sequential 1..N assumptions and support range-based numerical keys. |
| **`UniversalFirestoreClient`** | `server/services/admin/universalFirestoreService.js` | Concurrency-safe, project-bound Firestore client with batch commits and retry safety. | **Reused** for all profile and test persistence. |
| **`LegacyScoringAdapter`** | `server/services/scoring/legacyScoringAdapter.js` | Backward-compatibility scoring for historical Schema v1 attempts. | **Preserved untouched** to guarantee zero historical rescoring. |

---

## 5. Backward Compatibility & Historical Attempt Requirements

1. **Zero Rescoring of Historical Attempts:**
   Existing records in `mockAttempts` and `mockResults` must never be modified or rescored. Attempts with `schemaVersion: 1` or missing schema version continue routing through `LegacyScoringAdapter`.
2. **Profile Version Immutability:**
   Any exam profile generated by the new pipeline must be versioned (e.g. `gate-cs-2024.v1`, `cat-2024.v1`). Tests published with profile version $V_1$ remain pinned to $V_1$ even if an administrator re-analyzes documents and generates $V_2$.
3. **Data Model Continuity:**
   Generated tests must continue to populate standard `mockTests` fields (`testId`, `examId`, `year`, `title`, `durationSeconds`, `totalQuestions`, `maximumMarks`, `sections`) so that student catalog listings, attempt creation, and analytics continue operating without regression.

---

## 6. Audit Conclusion

The existing codebase contains excellent low-level engineering (exact rational arithmetic, cryptographic document hashing, and robust Firestore isolation). However, the high-level creation pipeline is blocked by hardcoded exam branches, static profile registries, and shallow pattern document extraction.

Transforming this into a document-driven pipeline requires:
1. Building genuine document parsers for Question Papers, Answer Keys, and Format Documents that extract structure rather than relying on regex heuristics.
2. Formulating a Universal Intermediate Representation (UIR) and dynamic Rule Reconciliation Engine.
3. Storing generated Exam Profiles as versioned configuration data in Firestore.
4. Upgrading the student test UI to render dynamic section tabs and diverse question types.
5. Providing an administrative review interface where document evidence, confidence scores, and blockers are presented for human sign-off before test publication.

