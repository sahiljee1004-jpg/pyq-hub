# Phase 2 Implementation Report: Universal Three-Document Ingestion Engine

**Repository:** `C:\Users\RUPENDRA\Documents\VidyarthiAstra-current`  
**Phase:** Phase 2 — Universal Document Ingestion Engine  
**Status:** Completed & Verified  
**Date:** 2026-11-14T02:52:00+05:30  
**Governing Standard:** Document-Driven Pipeline Architecture Specification v3.0  

---

## 1. Executive Summary

Phase 2 of the Document-Driven Mock Test Pipeline has been implemented and verified. The objective was to build an exam-agnostic, three-document ingestion engine that accepts:
1. **Original Question Paper (QP)** (PDF, digital or scanned)
2. **Official Answer Key (AK)** (PDF, tabular, dense token, multi-column)
3. **Official Paper Format / Pattern Document (PF)** (PDF, notification, information bulletin)

The engine extracts structured information without relying on hardcoded exam names, fixed question counts, fixed section counts, or hardcoded scoring heuristics.

### Key Verification Milestones:
- **New Ingestion Engine Test Suite:** `tests/universal-document-ingestion.test.js` — **18/18 tests passed (100%)**.
- **Full Workspace Test Suite:** 34 test suites executed — **634/634 tests passed (100%)**.
- **Zero Regressions:** All 616 existing baseline tests continue to pass with 0 failures.
- **Strict Stop:** Phase 2 execution is paused at this boundary. Phase 3 has not been initiated.

---

## 2. Ingestion Architecture & Module Inventory

All Phase 2 deliverables have been placed under `server/services/ingestion/`:

```
server/services/ingestion/
├── extractionSchema.js                     # Canonical extraction schemas & provenance models
├── questionPaperParser.js                  # Agnostic Question Paper parser (sections, stems, options, formulas, diagrams)
├── answerKeyParser.js                      # Multi-format Answer Key parser (ranges, dropped, multi-choice, scrambled)
├── paperFormatParser.js                    # Examination rules parser (duration, marks, optional policies, UNKNOWN/CONTRADICTORY)
├── ingestionValidator.js                   # Syntactic & structural validation gate
└── universalDocumentIngestionService.js    # Concurrency orchestrator, hashing & ingestion manifest compiler
```

### 2.1 Provenance Model (`extractionSchema.js`)
Every extracted parameter retains full source provenance and status:
```json
{
  "value": 120,
  "documentId": "paper_format",
  "pageNumber": 2,
  "evidenceText": "Duration of Test: 120 Minutes",
  "extractionMethod": "token_pattern",
  "confidence": 0.98,
  "status": "EXPLICIT"
}
```
- **Statuses Supported:** `EXPLICIT`, `INFERRED`, `UNKNOWN`, `CONTRADICTORY`.
- **Unknown Rule Guarantee:** If a parameter is missing in the document (e.g. negative marking omitted), it is assigned `status: "UNKNOWN"`, `value: null`, `confidence: 0.0`. The system **never** applies default assumptions.

### 2.2 Universal Question Paper Parser (`questionPaperParser.js`)
- **Agnostic Structural Detection:** Dynamically detects section breaks (`SECTION`, `PART`, `GROUP`, `SUBJECT:`) using linguistic and typographic patterns rather than fixed lists.
- **Dynamic Question Boundary Segmenter:** Identifies question boundaries (`Q. 1`, `1.`, `Question 1`, `(1)`) while respecting sequence continuity.
- **Option Extraction:** Extracts monotonic option series (`A..D`, `1..4`, `(a)..(d)`), standardizing to canonical identifiers while preserving original labels.
- **Formulas & Diagrams:** Reconstructs mathematical notation (`$...$`, LaTeX, powers, fractions, units) and detects diagram references (`Figure`, `Diagram`, `[Diagram]`).
- **Scanned Document Detection:** Calculates character density per page. If density is `< 50 chars/page`, flags `isScanned: true` and triggers the OCR routing blocker.

### 2.3 Universal Answer Key Parser (`answerKeyParser.js`)
- **Multi-Layout Support:** Tabular layouts (`Q.No | Key`), dense text tokens (`1-A 2-C 3-B`), and multi-column formats.
- **Decoupled Question Ordering:** Does not assume answer keys appear in sequential order or match QP physical order. Traces mappings by explicit question number.
- **Complex Answer Types:**
  - Multi-choice accepted answers (`A or C`, `2 or 4`, `B, D`).
  - Numerical ranges (`[12.4, 12.6]`, `12.5 +/- 0.5`, `12.4 to 12.6`).
  - Dropped / bonus questions (`Dropped`, `Bonus`, `Cancelled`, `*`).
- **Anomaly Detection:** Flags duplicate keys, ambiguous tokens, and sequence gaps.

### 2.4 Universal Paper Format Parser (`paperFormatParser.js`)
- **Comprehensive Rule Extraction:** Duration, total questions, maximum marks, section counts, positive marks, negative marks, unanswered marks.
- **Optional Question Policies:**
  - `choose_n_of_m`: Matches "attempt 5 questions out of 10", "attempt any 10 of 15 in Section B".
  - `first_k_attempted`: Matches "first 10 attempted questions will be evaluated".
- **Internal Contradiction Detection:** If a document asserts conflicting figures (e.g. line 5 says 100 questions, line 12 says 90 questions), marks `status: "CONTRADICTORY"` with `confidence: 0`.

### 2.5 Ingestion Orchestrator & Validator (`universalDocumentIngestionService.js`)
- Concurrently ingests all three documents.
- Verifies input types and PDF magic byte signatures (`%PDF-`).
- Computes SHA-256 digests for all three documents for tamper-evident provenance.
- Runs `IngestionValidator` to confirm structural sanity before passing raw extractions downstream.

---

## 3. Synthetic Document Fixtures & Test Results

A dedicated suite of synthetic documents was generated under `tests/fixtures/documents/syntheticExamFixtures.js`, covering all 8 required scenarios:

| # | Scenario | Test Objective | Status |
|---|---|---|---|
| 1 | **Conventional MCQ Exam** | Standard 3-question MCQ paper with full format rules, A..D options, sequential answer key | **PASS** |
| 2 | **Multi-Section with Distinct Marking** | Multiple sections (General Intelligence + Quantitative Aptitude) with different marking schemes (+1/-0.25 vs +2/-0.5) | **PASS** |
| 3 | **Optional Questions Policy** | Optional question instructions: "Candidates have to attempt 5 questions out of 10 in Section B" (`choose_n_of_m`) | **PASS** |
| 4 | **Numerical / NAT with Ranges** | Optionless numerical questions with accepted ranges (`[4.8, 5.0]`, `12.5 +/- 0.5`) and "no negative marking" | **PASS** |
| 5 | **Scanned Question Paper (OCR Gate)** | Question paper with text density < 50 chars/page; triggers `isScanned: true` and blocker | **PASS** |
| 6 | **Tables and Diagrams** | Preservation of embedded diagram markers (`Figure 3`) and multi-column data tables | **PASS** |
| 7 | **Deleted and Bonus Questions** | Answer keys with dropped/bonus questions and format document policy `full_marks_for_all` | **PASS** |
| 8 | **Incomplete & Contradictory Rules** | Contradictory question counts (100 vs 90) -> `CONTRADICTORY` blocker; missing negative marks -> strictly `UNKNOWN` | **PASS** |

### Test Suite Execution Output (`tests/universal-document-ingestion.test.js`):
```text
▶ Universal Three-Document Ingestion Engine (Phase 2)
  ▶ 1. Canonical Extraction Schema & Provenance Models
    ✔ 1.1 creates explicit extraction fields with full provenance (1.0754ms)
    ✔ 1.2 automatically tags null or empty values as UNKNOWN with confidence 0.0 (0.283ms)
    ✔ 1.3 preserves question and section extraction canonical structure (0.5317ms)
  ✔ 1. Canonical Extraction Schema & Provenance Models (3.0296ms)
  ▶ 2. Scenario 1: Conventional MCQ Exam Ingestion
    ✔ 2.1 successfully ingests and parses a standard 3-question MCQ paper (148.1472ms)
  ✔ 2. Scenario 1: Conventional MCQ Exam Ingestion (148.5083ms)
  ▶ 3. Scenario 2: Multiple Sections with Distinct Marking Rules
    ✔ 3.1 identifies distinct sections and their respective question boundaries (10.1267ms)
  ✔ 3. Scenario 2: Multiple Sections with Distinct Marking Rules (10.32ms)
  ▶ 4. Scenario 3: Optional Questions Policy Extraction
    ✔ 4.1 extracts choose-n-of-m optional question rule with exact provenance (12.5084ms)
  ✔ 4. Scenario 3: Optional Questions Policy Extraction (12.7624ms)
  ▶ 5. Scenario 4: Numerical / NAT Questions with Ranges
    ✔ 5.1 classifies optionless questions as numerical_nat and extracts answer key ranges (5.3304ms)
  ✔ 5. Scenario 4: Numerical / NAT Questions with Ranges (5.5657ms)
  ▶ 6. Scenario 5: Scanned Question Paper OCR Detection Gate
    ✔ 6.1 flags scanned PDF when text density is < 50 characters per page and produces validation blocker (3.6397ms)
  ✔ 6. Scenario 5: Scanned Question Paper OCR Detection Gate (3.7729ms)
  ▶ 7. Scenario 6: Paper Containing Tables and Diagrams
    ✔ 7.1 preserves embedded diagram markers and tabular structures (8.4486ms)
  ✔ 7. Scenario 6: Paper Containing Tables and Diagrams (8.5752ms)
  ▶ 8. Scenario 7: Answer Key with Deleted and Bonus Questions
    ✔ 8.1 extracts dropped and bonus questions with proper flags and format policy (4.299ms)
  ✔ 8. Scenario 7: Answer Key with Deleted and Bonus Questions (4.4423ms)
  ▶ 9. Scenario 8: Incomplete & Contradictory Format Rules
    ✔ 9.1 flags contradictory counts as CONTRADICTORY blocker and missing rules as UNKNOWN (3.9533ms)
  ✔ 9. Scenario 8: Incomplete & Contradictory Format Rules (4.0694ms)
  ▶ 10. Architectural Robustness & Exam-Agnostic Guarantee
    ✔ 10.1 parses multi-option answer key entries (e.g. 'A or C', '2 or 4') (0.5072ms)
    ✔ 10.2 handles dense / non-sequential answer keys and detects sequence gaps (0.3154ms)
    ✔ 10.3 computes stable SHA-256 digests and provenance records for all source inputs (8.5406ms)
    ✔ 10.4 maps decoupled and scrambled answer keys correctly without assuming QP sequence (0.3713ms)
    ✔ 10.5 detects corrupted font glyphs (\uFFFD) and marks question as unreadable (0.4578ms)
    ✔ 10.6 preserves mathematical formulas, LaTeX fragments, and physical units (0.2713ms)
    ✔ 10.7 throws descriptive error when mandatory documents are missing (0.7916ms)
  ✔ 10. Architectural Robustness & Exam-Agnostic Guarantee (11.6321ms)
✔ Universal Three-Document Ingestion Engine (Phase 2) (214.0807ms)
ℹ tests 18
ℹ suites 11
ℹ pass 18
ℹ fail 0
```

---

## 4. Full Workspace Test Suite Results

```text
=======================================================
TOTAL SUITES EXECUTED : 34
TOTAL TESTS EXECUTED  : 634
TOTAL PASSED          : 634
TOTAL FAILED          : 0
=======================================================
```

Every single existing suite passed without failures or regressions.

---

## 5. Safety & Operational Boundary Compliance

1. **No Exam Hardcoding:** Zero exam-name strings or hardcoded conditionals were introduced. The parser works solely from typographical, spatial, and linguistic document evidence.
2. **Never Default Missing Rules:** Missing rules produce `status: "UNKNOWN"` and `confidence: 0.0`.
3. **No Cloud Operations:** Zero external HTTP/network calls, zero GCP calls, zero production/staging writes.
4. **No Git Modifications:** Zero commits, zero pushes, branch maintained clean.

---

## 6. Current State & Next Phase Readiness

Phase 2 is fully complete and verified. The codebase is clean, tested, and paused.

**Next Phase (Phase 3):** Universal Intermediate Exam Representation (UIR v3.0) Schema & Serialization Engine. Phase 3 will not begin until instructed.

