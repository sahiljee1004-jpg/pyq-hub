# PHASE 5.9 — FORENSIC INVESTIGATION & ROOT CAUSE ANALYSIS REPORT

**Project:** VidyarthiAstra — Local Development & Application Runtime  
**Incident:** Every mock test stuck on skeleton loading screen; HTTP 429 / `RESOURCE_EXHAUSTED` on `GET /api/auth/session-role`  
**Date:** November 16, 2026  
**Status:** Root Cause Confirmed & Architecture Mapped

---

## 1. Incident Overview & Symptoms

During local development and mock test initialization, student mock tests remain stuck indefinitely on the skeleton placeholder.

### Endpoint Telemetry:
- **Failing Endpoint:** `GET /api/auth/session-role`
- **Underlying Failure:** `UniversalFirestoreService` receives HTTP 429 from Cloud Firestore REST API.
- **Firestore Status:** `RESOURCE_EXHAUSTED`
- **Error Payload:** `{"error": {"code": 429, "message": "Quota exceeded.", "status": "RESOURCE_EXHAUSTED"}}`
- **Target Resource:** Document path `projects/pyqs-hub-43bed/databases/(default)/documents/users/{userId}`
- **Application Response:** `[Auth API] Session role check error: Firestore query returned HTTP 429 ...` -> HTTP 500 `Internal server error`

---

## 2. End-to-End Execution Trace

```
1. Student Clicks "Start Mock Test"
   │
   ├──► Language Selection Modal Confirmed
   │
   ├──► startTestSession(testId, language) Invoked
   │      │
   │      ├──► SkeletonManager.mount(testView, mockInterface)
   │      │      [Skeleton renders shimmering interface, aria-busy="true"]
   │      │
   │      ├──► Client acquires Firebase ID Token (user.getIdToken())
   │      │
   │      ├──► [Parallel Client Trigger] header.js onAuthStateChanged fires
   │      │      └──► fetch("GET /api/auth/session-role")
   │      │
   │      └──► fetch("POST /api/mock-tests/:testId/attempts")
   │             └──► requireStudentAuth middleware
   │
2. Server Receives Concurrent Requests for users/{userId}
   │
   ├──► Route 1: GET /api/auth/session-role
   │      └──► verifyFirebaseIdToken(token) -> claims.sub
   │      └──► UniversalFirestoreService.getDocument("users", claims.sub)
   │             └──► No cache check in dev/prod -> Direct HTTP GET to Cloud Firestore
   │
   └──► Route 2: POST /api/mock-tests/:testId/attempts
          └──► requireStudentAuth middleware
          └──► verifyFirebaseIdToken(token) -> claims.sub
          └──► UniversalFirestoreService.getDocument("users", claims.sub)
                 └──► No cache check in dev/prod -> Direct HTTP GET to Cloud Firestore
   │
3. Cloud Firestore Returns HTTP 429 RESOURCE_EXHAUSTED
   │
   ├──► Free Tier (Spark Plan) daily read limit of 50,000 document reads exhausted
   │
   ├──► UniversalFirestoreService throws: "Firestore query returned HTTP 429: Quota exceeded"
   │
   ├──► auth.js catches and returns HTTP 500
   │
   └──► mockTests.js catches and returns HTTP 401 or falls back to "user" (or attempts collection fails)
   │
4. Frontend Catches Network Failure
   │
   ├──► startTestSession catch block entered:
   │      catch (err) {
   │          if (typeof testSessionSkeleton !== "undefined") testSessionSkeleton?.cancel();
   │          ...
   │      }
   │
   └──► DEFECT: testSessionSkeleton was declared using 'const' INSIDE the try block!
          In catch block, typeof testSessionSkeleton is "undefined".
          testSessionSkeleton.cancel() is NEVER CALLED!
          The skeleton placeholder remains mounted and visible indefinitely!
```

---

## 3. Forensic Investigation Findings

### Finding 1: Uncached REST Reads in `UniversalFirestoreService`
- **Location:** `server/services/admin/universalFirestoreService.js` (lines 564–613).
- **Behavior:** In `getDocument(collectionName, documentId)`, the internal cache (`localDocCache`) was **only** consulted if `process.env.NODE_ENV === "test"`.
- **Impact:** In development and production modes, **every single read of `users/{userId}` issued a raw HTTP GET request** to `https://firestore.googleapis.com/v1/projects/.../databases/(default)/documents/users/...`.
- **Result:** Even when the exact same document was requested dozens of times per minute by the same user, zero cache hits occurred.

### Finding 2: Zero Concurrent Request Coalescing (Single-Flight)
- When multiple requests for `users/{userId}` arrived within the same second (e.g. from `header.js` admin navigation check, `mock-test.js` session role verification, and `requireStudentAuth` middleware for attempts/autosaves), `UniversalFirestoreService` dispatched multiple parallel HTTP requests to Google Cloud for the exact same document path.

### Finding 3: Autosave Read Multiplication
- **Location:** `www/js/mock-test.js` (lines 1197, 1212) and `server/routes/mockTests.js` (lines 125–173).
- Every question answered triggers autosave (`PUT /api/mock-tests/attempts/:id`) after 500 ms debounce.
- `requireStudentAuth` guards this endpoint and re-fetches `users/{claims.sub}` from Cloud Firestore on **every autosave**.
- A student taking a 100-question test caused over 100 un-cached Firestore document reads for their user profile alone.

### Finding 4: Firestore Free Tier Quota Exhaustion Mechanism
- Cloud Firestore Spark (Free Plan) enforces a strict quota of **50,000 document reads per day**.
- Rapid successive tests, automated test runs, and continuous autosaves completely consumed the daily allocation.
- Once exceeded, Google Cloud Firestore rejects all read operations with:
  `HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded.`

### Finding 5: Block-Scoped Skeleton Handle Bug
- In `www/js/mock-test.js`:
  ```javascript
  try {
      const testSessionSkeleton = SkeletonManager.mount(testView, ...);
      ...
  } catch (err) {
      if (typeof testSessionSkeleton !== "undefined") testSessionSkeleton?.cancel();
  }
  ```
  Because `testSessionSkeleton` was scoped to the `try` block, the `catch` block never had access to the variable. When an error occurred, `testSessionSkeleton` was never cancelled or dismissed, leaving the user with an infinite skeleton loading screen.

---

## 4. Remediation Plan

1. **Phase 2 — Backend Read Optimization:**
   - Add single-flight request coalescing (`_inFlightReads` Map) to share concurrent in-flight promises.
   - Implement short-lived, size-bounded LRU in-memory cache with TTL (e.g. 60 seconds) for `UniversalFirestoreService.getDocument`.
   - Invalidate cache entries on writes/deletions.
   - Eliminate duplicate Firestore reads between auth middleware and session-role controller.

2. **Phase 3 — Quota Error Handling (429 / RESOURCE_EXHAUSTED):**
   - Detect HTTP 429 and `RESOURCE_EXHAUSTED` explicitly in `UniversalFirestoreService`.
   - Implement bounded exponential backoff with jitter for transient spikes, respecting `Retry-After`.
   - Distinguish quota exhaustion from auth (401), forbidden (403), not found (404), and server error (500).
   - Return structured HTTP 429 with `code: "FIRESTORE_QUOTA_EXHAUSTED"` and `Retry-After`.

3. **Phase 4 — Frontend Session-Role & Error Recovery:**
   - Scope `testSessionSkeleton` outside the `try` block.
   - Implement single-flight frontend session-role cache in `header.js` and `mock-test.js`.
   - When role check or initialization fails:
     - Terminate skeleton cleanly.
     - Display a recoverable error card with a bounded "Retry" button.
     - Prevent uncontrolled retry loops.
     - Keep user authenticated and resume mock-test setup upon successful retry.

4. **Phase 5 & 6 — Mock Test Integrity & Comprehensive Testing:**
   - Ensure timer remains deferred until questions load.
   - Verify UIR v3.0, UniversalScoringEngine, NAT/MCQ answer persistence remain unchanged.
   - Run targeted test suites for single-flight deduplication, caching TTL, 429 backoff, and UI retry lifecycles.
