# Phase 4 — Universal Mock-Test Generation and Runtime Integration Audit
**Date**: November 14, 2026  
**Auditor**: Senior Systems Architect & Full-Stack Engineer  
**Workspace**: `c:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Standard**: Universal Intermediate Representation (UIR v3.0) & Universal Mock-Test Runtime

---

## 1. Executive Summary

This audit evaluates the VidyarthiAstra / PYQS Hub application for integrating the **Universal Intermediate Representation (UIR v3.0)** into the live runtime. The core objective is to ensure that an administrator can upload three source documents (Question Paper, Answer Key, Paper Format/Syllabus) for **any** examination, generate a standardized mock test, preview and verify it, publish it to students, and allow students to attempt, autosave, submit, score, and review performance without requiring hardcoded exam-family branches, custom scoring scripts, or exam-specific UI templates.

The audit examined:
1. UIR v3.0 schema and adapters (`server/services/uir/`)
2. Admin import job pipeline and controllers (`server/services/admin/importJobPipelineService.js`, `server/routes/admin.js`)
3. Mock test creation and persistence services (`server/services/mockTestService.js`, `UniversalFirestoreService`)
4. Firestore document models (`mockTests`, `mockQuestions`, `mockAnswerKeys`, `mockAttempts`, `mockResults`)
5. Student mock-test runtime (`www/mock-test.html`, `www/js/mock-test.js`, `server/routes/mockTests.js`)
6. Scoring and evaluation engines (`server/services/mockTestScoringService.js`, `server/services/scoring/universalScoringEngine.js`, `rational.js`, `legacyScoringAdapter.js`)
7. Result generation, analytics, and attempt review interfaces
8. Historical attempt evaluation and backward-compatibility adapters

---

## 2. Component-by-Component Audit Findings

### 2.1 Admin Ingestion and Import Pipeline (`importJobPipelineService.js`, `server/routes/admin.js`)
- **Current Flow**:
  - `POST /api/admin/import/upload`: Accepts three PDF documents (Question Paper, Answer Key, Exam Pattern) as base64 buffers. Stores them in `StorageVaultService` with SHA-256 integrity hashes.
  - `POST /api/admin/import/start`: Invokes `ImportJobPipelineService.runPipeline(jobId)` asynchronously.
  - `ImportJobPipelineService.runPipeline`: Historically invoked legacy `MetadataExtractionService`, `ExamPatternService`, `QuestionNormalizationService`, and `AnswerKeyReconciliationService`.
- **Gaps & Remediation for Universal Document Pipeline**:
  - When three documents are uploaded, `ImportJobPipelineService` must seamlessly execute `UIRTransformationService.transformDocuments({ questionPaper: qpBuffer, answerKey: akBuffer, paperFormat: epBuffer }, { examId, year, paperCode })`.
  - The resulting `uirDocument` becomes the authoritative canonical package attached to `job.uirDocument` and `job.draftPackage`.
  - When manual corrections are performed (`correctQuestion`, `correctAnswerKey`), `UIRTransformationService.applyHumanCorrection` updates the question/key and clears or re-evaluates fidelity flags with an audit trail.
  - Publication blocker checks must invoke `UIRValidator.validate(job.uirDocument)` to ensure all quality flags, missing answers, and schema constraints are strictly validated before live deployment.

### 2.2 Firestore Document Models & Persistence (`uirAdapters.js`, `UniversalFirestoreService.js`)
- **Current Storage Schema**:
  - `mockTests`: Root metadata document (`testId`, `examId`, `examName`, `title`, `year`, `paperCode`, `durationSeconds`, `totalQuestions`, `maximumMarks`, `status`).
  - `mockQuestions`: Separate question documents (`questionId`, `testId`, `questionNumber`, `questionType`, `subject`, `questionText`, `options`, `diagramUrl`).
  - `mockAnswerKeys`: Isolated answer key documents (`questionId`, `testId`, `acceptedAnswers`, `marksAwarded`, `marksDeducted`).
- **Gaps & Remediation for Universal Pipeline**:
  - `mockTests` must persist complete `sections` (including section IDs, names, question ranges, question counts, required counts, and section-level scoring rules) and `scoringConfig` (default marks, optional question policies, dropped question policies), along with `schemaVersion: "3.0.0"`.
  - `mockQuestions` must preserve rich question types (`single_choice_mcq`, `multiple_choice_msq`, `numerical_nat`, `fill_in_blanks`, `matching`, `assertion_reason`, `passage_child`, `matrix_matching`, `descriptive_manual`), section references (`sectionId`, `sectionName`), marking schemes, passage texts, statements, tables, and bilingual language variants.
  - `mockAnswerKeys` must store `acceptedAnswers`, `numericValue`, `numericRange`, `numericTolerance`, `isDropped`, `isBonus`, `marksAwarded`, and `marksDeducted`.
  - `UIRToMockTestAdapter.toFirestoreDocuments(uirDoc)` generates `{ mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs }` matching these collections with zero schema drift.

### 2.3 Student Test Service & API (`mockTestService.js`, `server/routes/mockTests.js`)
- **Current State**:
  - `GET /api/mock-tests`: Lists published tests with year sorting, search, and pagination.
  - `GET /api/mock-tests/:testId`: Fetches test metadata and questions for students.
  - `POST /api/mock-tests/:testId/attempts`: Starts an authoritative test attempt with `deadlineAt` derived from server time + `durationSeconds`.
  - `PUT /api/mock-tests/attempts/:attemptId`: Autosaves candidate answers and marked-for-review set.
  - `POST /api/mock-tests/attempts/:attemptId/submit`: Evaluates candidate answers against protected answer keys and writes immutable `mockResults`.
- **Gaps & Remediation**:
  - `MockTestService.getTestForStudent`: Currently strips `sections` and `scoringConfig` from `test`, and omits `sectionId`, `sectionName`, `markingScheme`, and rich content (passage, statements, tables) from `questions`. It must pass these through while strictly preserving the confidentiality guarantee (never exposing `correctAnswer`, `acceptedAnswers`, or answer key details during the active attempt).
  - Bilingual variant resolution: `getTestForStudent` should resolve `q.translations` or `q.languageVariants` for the requested attempt language.

### 2.4 Student Mock-Test Player (`www/mock-test.html`, `www/js/mock-test.js`)
- **Current State**:
  - Renders single-choice radio buttons (`mcq`), checkboxes (`msq`), and single text input (`numerical`).
  - Displays a single flat question palette (1 to N).
  - Lacks section tabs/filtering, passage text rendering, assertion-reason structured layouts, fill-in-blanks inputs, matching pair selection, and descriptive text areas.
- **Gaps & Remediation**:
  - Section Management: When `activeTest.sections` is present, display section navigation tabs at the top of the test interface, allowing students to filter questions by section or jump directly to section boundaries.
  - Polymorphic Question Dispatcher:
    - `single_choice_mcq` / standard MCQ: Radio button list.
    - `multiple_choice_msq`: Checkbox list with multi-select guidance.
    - `numerical_nat`: Clean numeric input with allowed decimal/negative format guidance.
    - `fill_in_blanks`: Text blank input.
    - `assertion_reason`: Statement 1 (Assertion) and Statement 2 (Reason) formatted callouts with option selection.
    - `passage_child`: Reading passage / comprehension container displayed prominently above question stem.
    - `matching` / `matrix_matching`: Left-column and right-column paired tables with selection options.
    - `descriptive_manual`: Multi-line responsive textarea with character/word counter and formatting guidance.
  - Autosave & State Management: Ensure all input types serialize cleanly into `answers[questionId]` (string, number, array of strings) and sync via `PUT /api/mock-tests/attempts/:attemptId`.
  - Palette Updating: Palette buttons reflect: Answered (green), Not Answered (red), Marked for Review (purple), Not Visited (gray), and section grouping.

### 2.5 Scoring Engine & Evaluation (`mockTestScoringService.js`, `universalScoringEngine.js`)
- **Current State**:
  - `MockTestScoringService.evaluateAttempt` checks `isModernSchemaV2`. If true, it calls `UniversalScoringEngine.evaluateAttempt`.
  - If `resolvedProfile` is not pre-registered in `ExamProfileRegistry.findProfile`, `UniversalScoringEngine` rejects scoring unless `allowUnverified: true` or `adminApprovedForScoring: true` is set.
- **Gaps & Remediation**:
  - Modern Schema Detection: Expand `isModernSchemaV2` to recognize `schemaVersion === "3.0.0"`, `schemaVersion === 3`, presence of `examConfig.scoringConfig`, or `examConfig.sections`.
  - Dynamic Profile Synthesis: For any arbitrary newly ingested examination (such as `bpsc-prelims`, `synthetic-arseo-2026`, or state PSC papers), if `ExamProfileRegistry.findProfile` returns `null`, synthesize an authoritative declarative exam profile directly from `examConfig.sections` and `examConfig.scoringConfig`.
  - Mark Resolution: Ensure question-level marking overrides, section marking schemes, and exam default marking schemes are evaluated using exact `Rational` arithmetic.
  - Descriptive Handling: Ensure descriptive questions without manual grading produce `status: "pending_review"`, increment `pendingReviewCount`, and set `requiresManualEvaluation: true` and `isFinalized: false`.
  - Dropped & Bonus Policies: Handle full marks, pro-rata, and zero marks consistently.

### 2.6 Results, Analytics, and Review Interface
- **Current State**:
  - Displays total score, maximum score, percentage, accuracy, correct count, incorrect count, unattempted count, dropped count, and subject-wise score cards.
- **Gaps & Remediation**:
  - When `isFinalized === false` or `requiresManualEvaluation === true`, display a prominent "Evaluation in Progress" banner explaining that descriptive questions are pending instructor review.
  - Section-wise breakdown: Display score cards for each examination section in addition to subject cards.
  - Review Mode (`GET /api/mock-tests/attempts/:attemptId/review`): Reveal official accepted answers, candidate's selected choice, marks awarded/deducted, and explanations only after the attempt is submitted.

---

## 3. Identification of Hardcoded Assumptions & Required Fixes

| Location | Existing Hardcoded Assumption | Universal Remediated Behavior |
| :--- | :--- | :--- |
| `MockTestService.getTestForStudent` | Strips `sections`, `scoringConfig`, and `schemaVersion` from `test` | Pass `sections`, `scoringConfig`, `schemaVersion`, and instructions to client |
| `MockTestService.getTestForStudent` | Omits `sectionId`, `sectionName`, `markingScheme`, and rich stems | Include `sectionId`, `sectionName`, `markingScheme`, statements, tables, passage |
| `MockTestScoringService.evaluateAttempt` | Only checks `schemaVersion === 2`; relies on hardcoded `ExamProfileRegistry` | Recognize `schemaVersion: "3.0.0"`; synthesize profile from `examConfig.sections` & `scoringConfig` |
| `importJobPipelineService.js` | Uses legacy `QuestionNormalizationService` and `ExamPatternService` | Integrate `UIRTransformationService.transformDocuments` and `UIRValidator.validate` |
| `www/js/mock-test.js` | Only handles MCQ, MSQ, and NAT | Polymorphic renderer for all 9 UIR question types, section tabs, and descriptive inputs |
| `www/js/mock-test.js` | Result screen assumes test is always finalized | Display "Pending Instructor Review" notice when descriptive questions are pending |

---

## 4. Architectural Verification Plan
- **Verification 1**: Admin document ingestion, UIR generation, draft review, manual correction, and strict publication validation across UPSC Prelims 2026, BPSC 69th Prelims, JEE Main 2026 Shift 1, and synthetic ARSEO 2026.
- **Verification 2**: Student test player loading test metadata, section tabs, all question types, bilingual text variants, and answering via input controls.
- **Verification 3**: Submission, exact Rational scoring, section score calculations, optional question limits (first-K), negative marking overrides, and pending descriptive review handling.
- **Verification 4**: Regression tests on legacy attempts, authentication, project isolation, and zero live database side-effects.

---
*Audit Completed. Ready for Phase 2 Implementation.*

