import {
    getFirestoreBaseUrl,
    getFirestoreCommitUrl,
    getFirestoreServerAuthHeaders,
    validateProjectIdFormat
} from "../firebaseTokenService.js";

const localDocCache = new Map();

/**
 * Concurrency-Safe Immutable Firestore Client
 *
 * Encapsulates an immutable, permanent project ID binding.
 * Eliminates race conditions and crosstalk between concurrent operations
 * targeting different project environments.
 */
export class UniversalFirestoreClient {
    constructor(projectId) {
        this._projectId = validateProjectIdFormat(projectId, "UniversalFirestoreClient projectId");
        Object.freeze(this);
    }

    get projectId() {
        return this._projectId;
    }

    _resolveOptions(options = {}) {
        if (options?.projectId && options.projectId !== this._projectId) {
            throw new Error(`[UniversalFirestoreClient] CONFLICT SAFETY VIOLATION: Client is bound to project '${this._projectId}', but received conflicting options.projectId '${options.projectId}'. Conflicting project overrides are forbidden.`);
        }
        return { ...options, projectId: this._projectId };
    }

    ensureProject(expectedProjectId) {
        return UniversalFirestoreService.ensureProject(expectedProjectId, { projectId: this._projectId });
    }

    async getDocument(collectionName, documentId, options = {}) {
        return UniversalFirestoreService.getDocument(collectionName, documentId, this._resolveOptions(options));
    }

    async setDocument(collectionName, documentId, data, options = {}) {
        return UniversalFirestoreService.setDocument(collectionName, documentId, data, this._resolveOptions(options));
    }

    async deleteDocument(collectionName, documentId, options = {}) {
        return UniversalFirestoreService.deleteDocument(collectionName, documentId, this._resolveOptions(options));
    }

    async deleteDocumentAndSubcollections(collectionName, documentId, options = {}) {
        return UniversalFirestoreService.deleteDocumentAndSubcollections(collectionName, documentId, this._resolveOptions(options));
    }

    async commitBatch(writes, options = {}) {
        return UniversalFirestoreService.commitBatchWrites(writes, this._resolveOptions(options));
    }

    async commitBatchWrites(writes, options = {}) {
        return UniversalFirestoreService.commitBatchWrites(writes, this._resolveOptions(options));
    }

    async listSubcollectionIds(parentDocPath, options = {}) {
        return UniversalFirestoreService.listSubcollectionIds(parentDocPath, this._resolveOptions(options));
    }

    async listDocuments(collectionName, options = {}) {
        return UniversalFirestoreService.listDocuments(collectionName, this._resolveOptions(options));
    }

    async getDocuments(collectionName, options = {}) {
        return UniversalFirestoreService.getDocuments(collectionName, this._resolveOptions(options));
    }

    getDocumentPath(collectionName, documentId, options = {}) {
        return UniversalFirestoreService.getDocumentPath(collectionName, documentId, this._resolveOptions(options));
    }

    isQuotaCooldownActive() {
        return UniversalFirestoreService.isQuotaCooldownActive();
    }

    getQuotaCooldownRemainingMs() {
        return UniversalFirestoreService.getQuotaCooldownRemainingMs();
    }

    async saveImportedPackage(packageData, options = {}) {
        const resolvedOpts = this._resolveOptions(options || packageData?.options);
        return UniversalFirestoreService.saveImportedPackage({
            ...packageData,
            options: resolvedOpts
        });
    }
}

/**
 * Universal Firestore Service
 * 
 * Manages atomic commits, batch chunking (max 250 writes per batch to respect 500 limit),
 * schema serialization, and draft/published state transitions.
 */
export class UniversalFirestoreService {
    static _explicitProjectId = null;
    static _inFlightReads = new Map();
    static _ttlDocCache = new Map();
    static TTL_CACHE_MAX_ENTRIES = 1000;
    static DEFAULT_TTL_MS = 60_000; // 60 seconds bounded cache
    static _quotaCooldownUntil = 0; // Timestamp ms until which requests fail fast due to 429
    static _lastQuotaError = null;

    /**
     * Check if Firestore is in a quota exhaustion cooldown period
     */
    static isQuotaCooldownActive() {
        return Date.now() < this._quotaCooldownUntil;
    }

    /**
     * Get remaining quota cooldown in milliseconds
     */
    static getQuotaCooldownRemainingMs() {
        const rem = this._quotaCooldownUntil - Date.now();
        return rem > 0 ? rem : 0;
    }

    /**
     * Record a quota exhaustion event to trip the circuit breaker
     */
    static recordQuotaExhaustion(retryAfterSec = 30, details = "") {
        const cooldownMs = Math.max(1, retryAfterSec) * 1000;
        this._quotaCooldownUntil = Date.now() + cooldownMs;
        this._lastQuotaError = {
            time: Date.now(),
            retryAfter: retryAfterSec,
            details
        };
    }

    /**
     * Clear quota cooldown circuit breaker
     */
    static clearQuotaCooldown() {
        this._quotaCooldownUntil = 0;
        this._lastQuotaError = null;
    }

    /**
     * Add or update an entry in the bounded TTL document cache with LRU eviction
     * Supports negative caching (notFound: true) for 404 responses
     */
    static _addToTtlCache(key, data, ttlMs = this.DEFAULT_TTL_MS, notFound = false) {
        if (this._ttlDocCache.size >= this.TTL_CACHE_MAX_ENTRIES) {
            const oldestKey = this._ttlDocCache.keys().next().value;
            if (oldestKey) this._ttlDocCache.delete(oldestKey);
        }
        this._ttlDocCache.set(key, {
            data: data ? JSON.parse(JSON.stringify(data)) : null,
            notFound: Boolean(notFound),
            expiresAt: Date.now() + ttlMs,
            cachedAt: Date.now()
        });
    }

    /**
     * Explicitly invalidate a cached document
     */
    static invalidateDocument(collectionName, documentId, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const scopedKey = `${targetProject}:${cleanCol}/${cleanId}`;
        const legacyKey = `${cleanCol}/${cleanId}`;
        this._ttlDocCache.delete(scopedKey);
        this._inFlightReads.delete(scopedKey);
        localDocCache.delete(legacyKey);
    }

    /**
     * Create an immutable, concurrency-safe client instance permanently bound to a target project.
     * Preferred over mutable static configuration.
     */
    static forProject(projectId) {
        return new UniversalFirestoreClient(projectId);
    }

    static setProjectId(id) {
        if (id) {
            this._explicitProjectId = validateProjectIdFormat(id, "UniversalFirestoreService.projectId");
        } else {
            this._explicitProjectId = null;
        }
    }

    static get projectId() {
        const id = this._explicitProjectId || process.env.FIREBASE_PROJECT_ID;
        if (!id || typeof id !== "string" || !id.trim()) {
            throw new Error("[UniversalFirestoreService] FATAL: No Firestore project ID configured. An explicit project ID or bound client instance (UniversalFirestoreService.forProject(projectId)) is mandatory. Ambient fallback to production default is strictly disabled.");
        }
        return validateProjectIdFormat(id, "UniversalFirestoreService.projectId");
    }

    /**
     * Ensure that the currently initialized Firestore client project matches the explicit target project.
     * Rejects missing, blank, malformed, or mismatched project IDs.
     */
    static ensureProject(expectedProjectId, options = {}) {
        const validated = validateProjectIdFormat(expectedProjectId, "expectedProjectId");
        const current = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        if (current !== validated) {
            throw new Error(`[UniversalFirestoreService] SAFETY VIOLATION: Initialized Firestore client project '${current}' does not match expected target '${validated}'! Cross-project client execution is blocked.`);
        }
        return current;
    }

    /**
     * Convert JavaScript object to Firestore REST API fields
     */
    static toFirestoreValue(val) {
        if (val === null || val === undefined) {
            return { nullValue: null };
        }
        if (typeof val === "boolean") {
            return { booleanValue: val };
        }
        if (typeof val === "number") {
            if (Number.isInteger(val)) {
                return { integerValue: String(val) };
            }
            return { doubleValue: val };
        }
        if (typeof val === "string") {
            return { stringValue: val };
        }
        if (Array.isArray(val)) {
            return {
                arrayValue: {
                    values: val.map(item => this.toFirestoreValue(item))
                }
            };
        }
        if (typeof val === "object") {
            const fields = {};
            for (const [k, v] of Object.entries(val)) {
                if (v !== undefined) {
                    fields[k] = this.toFirestoreValue(v);
                }
            }
            return { mapValue: { fields } };
        }
        return { stringValue: String(val) };
    }

    /**
     * Convert plain object into Firestore fields object
     */
    static toFirestoreFields(obj) {
        const fields = {};
        for (const [k, v] of Object.entries(obj)) {
            if (v !== undefined && !k.startsWith("_")) {
                fields[k] = this.toFirestoreValue(v);
            }
        }
        return fields;
    }

    /**
     * Convert Firestore REST value back to plain JavaScript value
     */
    static fromFirestoreValue(fieldVal) {
        if (!fieldVal || typeof fieldVal !== "object") return null;
        if ("stringValue" in fieldVal) return fieldVal.stringValue;
        if ("integerValue" in fieldVal) return parseInt(fieldVal.integerValue, 10);
        if ("doubleValue" in fieldVal) return fieldVal.doubleValue;
        if ("booleanValue" in fieldVal) return fieldVal.booleanValue;
        if ("nullValue" in fieldVal) return null;
        if ("timestampValue" in fieldVal) return fieldVal.timestampValue;
        if ("arrayValue" in fieldVal) {
            return (fieldVal.arrayValue.values || []).map(item => this.fromFirestoreValue(item));
        }
        if ("mapValue" in fieldVal) {
            const obj = {};
            for (const [k, v] of Object.entries(fieldVal.mapValue.fields || {})) {
                obj[k] = this.fromFirestoreValue(v);
            }
            return obj;
        }
        return null;
    }

    /**
     * Generate monotonically increasing RFC 3339 server timestamp with microsecond resolution
     */
    static generateServerTimestamp() {
        const now = new Date();
        if (!this._timestampCounter) this._timestampCounter = 0;
        this._timestampCounter = (this._timestampCounter + 1) % 1000;
        const baseIso = now.toISOString();
        const micros = String(this._timestampCounter).padStart(3, "0");
        return baseIso.replace("Z", `${micros}Z`);
    }

    /**
     * Helper to construct full Firestore REST document path
     */
    static getDocumentPath(collectionName, documentId, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        return `projects/${targetProject}/databases/(default)/documents/${cleanCol}/${cleanId}`;
    }

    /**
     * Convert Firestore REST document to plain JS object preserving server updateTime and createTime
     */
    static fromFirestoreDocument(doc) {
        if (!doc) return null;
        if (!doc.fields) {
            // Already a plain JS object
            if (typeof doc === "object") {
                return JSON.parse(JSON.stringify(doc));
            }
            return null;
        }
        const result = {};
        for (const [k, v] of Object.entries(doc.fields)) {
            result[k] = this.fromFirestoreValue(v);
        }
        if (doc.updateTime) {
            result._updateTime = doc.updateTime;
        }
        if (doc.createTime) {
            result._createTime = doc.createTime;
        }
        return result;
    }

    /**
     * Commit a batch of writes via Firestore REST API (chunks max 250 writes per request)
     */
    static async commitBatchWrites(writes, options = {}) {
        if (!Array.isArray(writes) || writes.length === 0) {
            return { success: true, count: 0 };
        }

        const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

        // Fail-closed safety guard: Never perform destructive writes against production pyqs-hub-43bed in test without emulator
        if (process.env.NODE_ENV === "test" && !isEmulator) {
            // Validate all preconditions against localDocCache atomically before applying ANY write
            for (const write of writes) {
                const fullPath = write.update?.name || write.delete;
                const parts = (fullPath || "").split("/documents/");
                const relativePath = parts.length > 1 ? parts[1] : fullPath;
                if (!relativePath) continue;

                if (write.currentDocument?.exists === false) {
                    const hasExisted = write._precheckExisted !== undefined
                        ? Boolean(write._precheckExisted)
                        : (Boolean(relativePath) && localDocCache.has(relativePath));
                    if (hasExisted) {
                        const err = new Error(`Document collision: Document ${relativePath} already exists (createOnly precondition failed)`);
                        err.code = "ALREADY_EXISTS";
                        err.statusCode = 409;
                        throw err;
                    }
                }

                if (write.currentDocument?.exists === true) {
                    if (!localDocCache.has(relativePath)) {
                        const err = new Error(`Document precondition failed: Document ${relativePath} does not exist (exists: true precondition failed)`);
                        err.code = "FAILED_PRECONDITION";
                        err.statusCode = 412;
                        throw err;
                    }
                }

                if (write.currentDocument?.updateTime) {
                    const existing = localDocCache.get(relativePath);
                    if (!existing) {
                        const err = new Error(`Document precondition failed: Document ${relativePath} does not exist (updateTime precondition failed)`);
                        err.code = "FAILED_PRECONDITION";
                        err.statusCode = 412;
                        throw err;
                    }
                    if (existing._updateTime && existing._updateTime !== write.currentDocument.updateTime) {
                        const err = new Error(`Document precondition failed: Document ${relativePath} updateTime mismatch (expected ${write.currentDocument.updateTime}, found ${existing._updateTime})`);
                        err.code = "FAILED_PRECONDITION";
                        err.statusCode = 412;
                        throw err;
                    }
                }
            }

            const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
            // All preconditions passed: apply writes in-memory to localDocCache atomically with monotonic updateTime
            for (const write of writes) {
                const fullPath = write.update?.name || write.delete;
                const parts = (fullPath || "").split("/documents/");
                const relativePath = parts.length > 1 ? parts[1] : fullPath;
                if (relativePath) {
                    const scopedKey = `${targetProject}:${relativePath}`;
                    if (write.update) {
                        const newUpdateTime = this.generateServerTimestamp();
                        const parsed = this.fromFirestoreDocument(write.update) || {};
                        parsed._updateTime = newUpdateTime;
                        if (!localDocCache.has(relativePath)) {
                            parsed._createTime = newUpdateTime;
                        } else {
                            parsed._createTime = localDocCache.get(relativePath)?._createTime || newUpdateTime;
                        }
                        localDocCache.set(relativePath, parsed);
                        this._addToTtlCache(scopedKey, parsed);
                    } else if (write.delete) {
                        localDocCache.delete(relativePath);
                        this._ttlDocCache.delete(scopedKey);
                    }
                }
            }
            return { success: true, count: writes.length };
        }

        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const commitUrl = getFirestoreCommitUrl(targetProject);
        const authHeaders = await getFirestoreServerAuthHeaders(targetProject) || {};
        const CHUNK_SIZE = 250; // Keep safely under Firestore 500 batch limit
        let totalCommitted = 0;

        for (let i = 0; i < writes.length; i += CHUNK_SIZE) {
            const rawChunk = writes.slice(i, i + CHUNK_SIZE);
            const chunk = rawChunk.map(w => {
                const cleanWrite = { ...w };
                delete cleanWrite._precheckExisted;
                return cleanWrite;
            });
            const body = { writes: chunk };

            const response = await fetch(commitUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...authHeaders
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 429) {
                    const retryAfterSec = parseInt(response.headers.get("retry-after") || "30", 10);
                    this.recordQuotaExhaustion(retryAfterSec, errText);
                    const quotaErr = new Error(`Firestore write quota exceeded (HTTP 429: RESOURCE_EXHAUSTED)`);
                    quotaErr.code = "RESOURCE_EXHAUSTED";
                    quotaErr.statusCode = 429;
                    quotaErr.isQuotaExhausted = true;
                    quotaErr.retryAfter = retryAfterSec;
                    quotaErr.details = errText;
                    throw quotaErr;
                }
                console.error(`[UniversalFirestoreService] Batch commit error (status ${response.status}):`, errText);
                const err = new Error(`Firestore batch write failed (status ${response.status}): ${errText}`);
                if (response.status === 409 || errText.includes("ALREADY_EXISTS")) {
                    err.code = "ALREADY_EXISTS";
                    err.statusCode = 409;
                } else if (response.status === 400 || response.status === 412 || errText.includes("FAILED_PRECONDITION") || errText.includes("ABORTED")) {
                    err.code = "FAILED_PRECONDITION";
                    err.statusCode = 412;
                }
                throw err;
            }

            let commitData = null;
            try {
                commitData = await response.json();
            } catch (e) {}

            // Update local cache on successful batch commit with Firestore-assigned updateTime
            for (let idx = 0; idx < chunk.length; idx++) {
                const write = chunk[idx];
                const writeResult = commitData?.writeResults?.[idx];
                const fullPath = write.update?.name || write.delete;
                const parts = (fullPath || "").split("/documents/");
                const relativePath = parts.length > 1 ? parts[1] : fullPath;
                if (relativePath) {
                    const scopedKey = `${targetProject}:${relativePath}`;
                    if (write.update) {
                        const parsed = this.fromFirestoreDocument(write.update);
                        if (writeResult?.updateTime) {
                            parsed._updateTime = writeResult.updateTime;
                        }
                        localDocCache.set(relativePath, parsed);
                        this._addToTtlCache(scopedKey, parsed);
                    } else if (write.delete) {
                        localDocCache.delete(relativePath);
                        this._ttlDocCache.delete(scopedKey);
                    }
                }
            }

            totalCommitted += chunk.length;
        }

        return { success: true, count: totalCommitted };
    }

    /**
     * Upsert or create a document to Firestore
     * @param {string} collectionName
     * @param {string} documentId
     * @param {object} data
     * @param {object} options - { createOnly: boolean, precondition: object }
     */
    static async setDocument(collectionName, documentId, data, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const cacheKey = `${cleanCol}/${cleanId}`;
        const alreadyExists = localDocCache.has(cacheKey);

        if (options.createOnly && alreadyExists) {
            const err = new Error(`Document collision: Document ${cleanCol}/${cleanId} already exists (createOnly violation)`);
            err.code = "ALREADY_EXISTS";
            err.statusCode = 409;
            throw err;
        }

        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const fullDocPath = `projects/${targetProject}/databases/(default)/documents/${cleanCol}/${cleanId}`;
        const fields = this.toFirestoreFields(data);
        const write = {
            update: {
                name: fullDocPath,
                fields
            }
        };

        if (options.createOnly) {
            write.currentDocument = { exists: false };
            write._precheckExisted = alreadyExists;
        } else if (options.precondition) {
            write.currentDocument = options.precondition;
        }

        // Commit atomically without premature mutation of localDocCache
        const result = await this.commitBatchWrites([write], { ...options, projectId: targetProject });
        return result;
    }

    /**
     * Delete a document from Firestore
     */
    static async deleteDocument(collectionName, documentId, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const fullDocPath = `projects/${targetProject}/databases/(default)/documents/${cleanCol}/${cleanId}`;
        const write = {
            delete: fullDocPath
        };
        const result = await this.commitBatchWrites([write], { ...options, projectId: targetProject });
        this.invalidateDocument(cleanCol, cleanId, { projectId: targetProject });
        return result;
    }

    /**
     * Recursively delete a document and all its nested subcollections
     */
    /**
     * List all subcollection IDs for a parent document with pagination support
     *
     * @param {string} parentDocRelative - e.g. "mockTests/test-1"
     * @returns {Promise<string[]>} Array of subcollection IDs
     */
    static async listSubcollectionIds(parentDocRelative, options = {}) {
        const cleanParent = parentDocRelative.replace(/^\/+|\/+$/g, "");
        const subColIds = new Set();
        const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

        if (!isEmulator && process.env.NODE_ENV === "test") {
            const prefix = `${cleanParent}/`;
            for (const key of localDocCache.keys()) {
                if (key.startsWith(prefix)) {
                    const remainder = key.substring(prefix.length);
                    const parts = remainder.split("/");
                    if (parts.length >= 2) {
                        subColIds.add(parts[0]);
                    }
                }
            }
            return Array.from(subColIds);
        }

        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const baseUrl = getFirestoreBaseUrl(targetProject);
        const authHeaders = await getFirestoreServerAuthHeaders(targetProject) || {};
        const listColsUrl = `${baseUrl}/${cleanParent}:listCollectionIds`;

        let pageToken = null;
        do {
            const body = pageToken ? { pageToken, pageSize: 100 } : { pageSize: 100 };
            const res = await fetch(listColsUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to list subcollections for ${cleanParent} (HTTP ${res.status}): ${errText}`);
            }

            const data = await res.json();
            for (const id of data.collectionIds || []) {
                subColIds.add(id);
            }
            pageToken = data.nextPageToken || null;
        } while (pageToken);

        return Array.from(subColIds);
    }

    /**
     * Recursively delete a document and all its nested subcollections.
     * Guarantees error propagation: any child deletion failure halts the process.
     */
    static async deleteDocumentAndSubcollections(collectionName, documentId, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const fullDocRelative = `${cleanCol}/${cleanId}`;
        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;

        // Discover all nested subcollections (with pagination support)
        const subColIds = await this.listSubcollectionIds(fullDocRelative, { ...options, projectId: targetProject });
        for (const subColId of subColIds) {
            const subColPath = `${fullDocRelative}/${subColId}`;
            const subDocs = await this.listDocuments(subColPath, { ...options, projectId: targetProject });
            for (const subDoc of subDocs) {
                const sId = subDoc.id || subDoc.name?.split("/").pop();
                if (sId) {
                    // Recursive deletion: any error will propagate and abort parent deletion
                    await this.deleteDocumentAndSubcollections(subColPath, sId, { ...options, projectId: targetProject });
                }
            }
        }

        // Clean localDocCache subcollection keys
        const prefix = `${fullDocRelative}/`;
        for (const key of localDocCache.keys()) {
            if (key.startsWith(prefix)) {
                localDocCache.delete(key);
            }
        }

        return await this.deleteDocument(cleanCol, cleanId, { ...options, projectId: targetProject });
    }

    /**
     * Clear local document cache (for testing or cache invalidation)
     */
    static clearLocalCache() {
        localDocCache.clear();
        this._ttlDocCache.clear();
        this._inFlightReads.clear();
        this.clearQuotaCooldown();
    }

    /**
     * Get a document from Firestore with single-flight request coalescing,
     * bounded TTL caching, negative 404 caching, and structured HTTP 429 quota exhaustion handling.
     */
    static async getDocument(collectionName, documentId, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const cleanId = String(documentId).replace(/^\/+|\/+$/g, "");
        const legacyCacheKey = `${cleanCol}/${cleanId}`;

        const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

        // 1. In automated unit test environment without emulator, preserve localDocCache priority unless explicit ttlMs or skipCache is requested
        if (!isEmulator && process.env.NODE_ENV === "test" && options.ttlMs === undefined && !options.skipCache) {
            const cached = localDocCache.get(legacyCacheKey);
            if (cached !== undefined) {
                return cached ? JSON.parse(JSON.stringify(cached)) : null;
            }
        }

        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const scopedCacheKey = `${targetProject}:${cleanCol}/${cleanId}`;

        // 2. Check short-lived, size-bounded in-memory TTL cache (including negative 404 cache)
        const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : this.DEFAULT_TTL_MS;
        if (!options.skipCache) {
            const ttlEntry = this._ttlDocCache.get(scopedCacheKey);
            if (ttlEntry && Date.now() < ttlEntry.expiresAt) {
                if (ttlEntry.notFound) {
                    return null;
                }
                return ttlEntry.data ? JSON.parse(JSON.stringify(ttlEntry.data)) : null;
            }
        }

        // 3. Single-flight request coalescing: reuse in-flight promise for concurrent requests
        if (this._inFlightReads.has(scopedCacheKey)) {
            return await this._inFlightReads.get(scopedCacheKey);
        }

        // 3b. Circuit breaker: if quota cooldown is active, fail fast without issuing network request
        if (this.isQuotaCooldownActive() && !options.skipQuotaCooldown) {
            const remainingSec = Math.max(1, Math.ceil(this.getQuotaCooldownRemainingMs() / 1000));
            const quotaErr = new Error(`Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED). Circuit breaker active, retry after ${remainingSec}s.`);
            quotaErr.code = "RESOURCE_EXHAUSTED";
            quotaErr.statusCode = 429;
            quotaErr.isQuotaExhausted = true;
            quotaErr.retryAfter = remainingSec;
            quotaErr.details = this._lastQuotaError?.details || "Quota cooldown active";
            throw quotaErr;
        }

        // 4. Construct execution promise with backoff and quota error handling
        const executeFetch = async () => {
            const baseUrl = getFirestoreBaseUrl(targetProject);
            const docUrl = `${baseUrl}/${cleanCol}/${encodeURIComponent(cleanId)}`;
            const authHeaders = await getFirestoreServerAuthHeaders(targetProject) || {};

            const maxAttempts = options.maxRetries !== undefined ? options.maxRetries : 2;
            let lastErr = null;

            for (let attempt = 0; attempt <= maxAttempts; attempt++) {
                try {
                    const res = await fetch(docUrl, {
                        method: "GET",
                        headers: { ...authHeaders }
                    });

                    // 4a. Not Found (404) - Cache negative result with bounded TTL
                    if (res.status === 404) {
                        localDocCache.delete(legacyCacheKey);
                        const negativeTtlMs = typeof options.negativeTtlMs === "number" ? options.negativeTtlMs : ttlMs;
                        this._addToTtlCache(scopedCacheKey, null, negativeTtlMs, true);
                        return null;
                    }

                    // 4b. Quota Exhaustion (429 / RESOURCE_EXHAUSTED)
                    if (res.status === 429) {
                        const errText = await res.text();
                        const retryAfterSec = parseInt(res.headers.get("retry-after") || "30", 10);
                        this.recordQuotaExhaustion(retryAfterSec, errText);
                        console.error(`[UniversalFirestoreService] QUOTA EXHAUSTED: HTTP 429 RESOURCE_EXHAUSTED querying ${cleanCol}/${cleanId} (Target Project: ${targetProject}, attempt ${attempt + 1}/${maxAttempts + 1}). Retry-After: ${retryAfterSec}s.`);

                        const quotaErr = new Error(`Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED) for ${cleanCol}/${cleanId}`);
                        quotaErr.code = "RESOURCE_EXHAUSTED";
                        quotaErr.statusCode = 429;
                        quotaErr.isQuotaExhausted = true;
                        quotaErr.retryAfter = retryAfterSec;
                        quotaErr.details = errText;

                        // Only retry once if transient rate limit with very low retry-after (<= 2s)
                        if (attempt < maxAttempts && retryAfterSec <= 2) {
                            const delay = Math.min(2000, (attempt + 1) * 500 + Math.random() * 200);
                            await new Promise(r => setTimeout(r, delay));
                            continue;
                        }

                        throw quotaErr;
                    }

                    // 4c. Other HTTP Errors
                    if (!res.ok) {
                        const errText = await res.text();
                        console.error(`[UniversalFirestoreService] Firestore HTTP ${res.status} error querying ${docUrl}: ${errText}`);
                        
                        const httpErr = new Error(`Firestore query returned HTTP ${res.status}: ${errText} (Endpoint: ${isEmulator ? 'Emulator' : 'Cloud Firestore'}, Project: ${targetProject})`);
                        httpErr.statusCode = res.status;
                        httpErr.code = res.status === 503 ? "FIRESTORE_SERVICE_UNAVAILABLE" : `HTTP_${res.status}`;

                        // Retry on transient 503 Service Unavailable
                        if (res.status === 503 && attempt < maxAttempts) {
                            const delay = (attempt + 1) * 500 + Math.random() * 200;
                            await new Promise(r => setTimeout(r, delay));
                            continue;
                        }

                        throw httpErr;
                    }

                    // 4d. Successful Document Read
                    const doc = await res.json();
                    const parsed = this.fromFirestoreDocument(doc);

                    // Update both caches
                    localDocCache.set(legacyCacheKey, parsed);
                    this._addToTtlCache(scopedCacheKey, parsed, ttlMs);

                    return parsed ? JSON.parse(JSON.stringify(parsed)) : null;

                } catch (err) {
                    lastErr = err;
                    if (err.isQuotaExhausted || err.statusCode === 404) {
                        throw err;
                    }
                    if (attempt < maxAttempts) {
                        const delay = (attempt + 1) * 300 + Math.random() * 150;
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                }
            }

            // Connection or fatal failure
            const connErr = new Error(`Connection failure retrieving ${cleanCol}/${cleanId}: ${lastErr?.message || "Unknown error"}`);
            connErr.code = lastErr?.code || "FIRESTORE_CONNECTION_ERROR";
            connErr.statusCode = lastErr?.statusCode || 503;
            connErr.isQuotaExhausted = Boolean(lastErr?.isQuotaExhausted);
            connErr.retryAfter = lastErr?.retryAfter;
            throw connErr;
        };

        const inFlightPromise = executeFetch();
        this._inFlightReads.set(scopedCacheKey, inFlightPromise);

        try {
            return await inFlightPromise;
        } finally {
            this._inFlightReads.delete(scopedCacheKey);
        }
    }

    /**
     * List documents in a collection from Firestore or local cache
     */
    static async listDocuments(collectionName, options = {}) {
        const cleanCol = collectionName.replace(/^\/+|\/+$/g, "");
        const resultsMap = new Map();

        const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

        // Circuit breaker: fail fast if quota exhaustion cooldown is active
        if (this.isQuotaCooldownActive() && !options.skipQuotaCooldown) {
            const remainingSec = Math.max(1, Math.ceil(this.getQuotaCooldownRemainingMs() / 1000));
            const quotaErr = new Error(`Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED) listing collection ${cleanCol}. Circuit breaker active, retry after ${remainingSec}s.`);
            quotaErr.code = "RESOURCE_EXHAUSTED";
            quotaErr.statusCode = 429;
            quotaErr.isQuotaExhausted = true;
            quotaErr.retryAfter = remainingSec;
            quotaErr.details = this._lastQuotaError?.details || "Quota cooldown active";
            throw quotaErr;
        }

        if (!isEmulator && process.env.NODE_ENV === "test" && !options.forceRemote && !options.skipCache) {
            const prefix = `${cleanCol}/`;
            for (const [key, val] of localDocCache.entries()) {
                if (key.startsWith(prefix)) {
                    const id = key.substring(prefix.length);
                    if (!id.includes("/")) {
                        resultsMap.set(id, { id, ...val });
                    }
                }
            }
            return Array.from(resultsMap.values());
        }

        // Attempt fetching from Firestore REST API with pagination support
        const targetProject = options?.projectId ? validateProjectIdFormat(options.projectId, "options.projectId") : this.projectId;
        const baseUrl = getFirestoreBaseUrl(targetProject);
        const colUrl = `${baseUrl}/${cleanCol}`;
        const authHeaders = await getFirestoreServerAuthHeaders(targetProject) || {};

        try {
            let pageToken = null;
            do {
                const url = pageToken ? `${colUrl}?pageToken=${encodeURIComponent(pageToken)}` : colUrl;
                const res = await fetch(url, {
                    method: "GET",
                    headers: { ...authHeaders }
                });

                if (res.status === 429) {
                    const errText = await res.text();
                    const retryAfterSec = parseInt(res.headers.get("retry-after") || "30", 10);
                    this.recordQuotaExhaustion(retryAfterSec, errText);
                    console.error(`[UniversalFirestoreService] QUOTA EXHAUSTED: HTTP 429 RESOURCE_EXHAUSTED listing collection ${cleanCol} (Target Project: ${targetProject}). Retry-After: ${retryAfterSec}s.`);

                    const quotaErr = new Error(`Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED) for collection ${cleanCol}`);
                    quotaErr.code = "RESOURCE_EXHAUSTED";
                    quotaErr.statusCode = 429;
                    quotaErr.isQuotaExhausted = true;
                    quotaErr.retryAfter = retryAfterSec;
                    quotaErr.details = errText;
                    throw quotaErr;
                }

                if (!res.ok) {
                    const errText = await res.text();
                    console.error(`[UniversalFirestoreService] Firestore HTTP ${res.status} error querying collection ${cleanCol}: ${errText}`);
                    const httpErr = new Error(`Firestore query returned HTTP ${res.status}: ${errText} (Endpoint: ${isEmulator ? 'Emulator' : 'Cloud Firestore'}, Project: ${targetProject})`);
                    httpErr.statusCode = res.status;
                    httpErr.code = res.status === 503 ? "FIRESTORE_SERVICE_UNAVAILABLE" : `HTTP_${res.status}`;
                    throw httpErr;
                }

                const body = await res.json();
                const remoteDocs = body.documents || [];
                for (const d of remoteDocs) {
                    const parsed = this.fromFirestoreDocument(d);
                    const id = d.name.split("/").pop();
                    resultsMap.set(id, { id, ...parsed });
                    localDocCache.set(`${cleanCol}/${id}`, parsed);
                }
                pageToken = body.nextPageToken || null;
            } while (pageToken);
        } catch (err) {
            // Never silently swallow quota or backend errors into an empty array!
            throw err;
        }

        return Array.from(resultsMap.values());
    }

    static async getDocuments(collectionName, options = {}) {
        return this.listDocuments(collectionName, options);
    }

    /**
     * Save an entire imported paper package atomically:
     * 1. examConfigs (ONLY written for production imports, NEVER for synthetic tests)
     * 2. mockTests (draft status, with collision guards)
     * 3. mockQuestions (student-visible questions)
     * 4. mockAnswerKeys (protected answers)
     * 5. paperImportJobs (job status record)
     * 6. exams/{examId}/years/{yearId}/papers/{paperId}/questions (legacy sync for backward compatibility, SKIPPED for tests)
     */
    static async saveImportedPackage({
        examConfig,
        mockTest,
        questions,
        answerKeys,
        job,
        options = {}
    }) {
        const targetProject = options?.projectId
            ? validateProjectIdFormat(options.projectId, "options.projectId")
            : this.projectId;
        const writes = [];
        const basePath = `projects/${targetProject}/databases/(default)/documents`;

        const isSynthetic = Boolean(
            mockTest?.isSyntheticTest ||
            mockTest?.testRunId ||
            job?.isSyntheticTest ||
            job?.testRunId ||
            (mockTest?.examId && (mockTest.examId.startsWith("synthetic-") || mockTest.examId.startsWith("test-")))
        );

        if (isSynthetic) {
            const testRunId = mockTest?.testRunId || job?.testRunId;
            if (!testRunId || typeof testRunId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(testRunId)) {
                throw new Error("Synthetic test import requires a valid testRunId (8-64 alphanumeric characters, underscores, or dashes)");
            }

            const PRODUCTION_EXAM_IDS = new Set(["neet-ug", "jee-main", "upsc-prelims", "gate-cs", "nda", "cuet-ug"]);
            if (PRODUCTION_EXAM_IDS.has(String(mockTest?.examId).toLowerCase())) {
                throw new Error(`Synthetic tests cannot use production exam identifiers (${mockTest.examId}). Use dedicated synthetic namespace like 'synthetic-qa-exam'.`);
            }
        }

        const createOnly = Boolean(options.createOnly || isSynthetic);

        // Precondition collision check for mockTest
        if (createOnly && mockTest?.testId) {
            if (localDocCache.has(`mockTests/${mockTest.testId}`)) {
                throw new Error(`Document collision: Test ${mockTest.testId} already exists in Firestore`);
            }
        }

        // 1. examConfigs/{configId} - ONLY written for legitimate production imports, NEVER for synthetic tests
        if (!isSynthetic && examConfig && examConfig.configId) {
            localDocCache.set(`examConfigs/${examConfig.configId}`, JSON.parse(JSON.stringify(examConfig)));
            writes.push({
                update: {
                    name: `${basePath}/examConfigs/${examConfig.configId}`,
                    fields: this.toFirestoreFields(examConfig)
                }
            });
        }

        // 2. mockTests/{testId}
        if (mockTest && mockTest.testId) {
            localDocCache.set(`mockTests/${mockTest.testId}`, JSON.parse(JSON.stringify(mockTest)));
            const write = {
                update: {
                    name: `${basePath}/mockTests/${mockTest.testId}`,
                    fields: this.toFirestoreFields(mockTest)
                }
            };
            if (createOnly) {
                write.currentDocument = { exists: false };
                write._precheckExisted = false;
            }
            writes.push(write);
        }

        // 3. mockQuestions/{questionId}
        for (const q of questions) {
            if (createOnly && localDocCache.has(`mockQuestions/${q.questionId}`)) {
                throw new Error(`Document collision: Question ${q.questionId} already exists in Firestore`);
            }
            localDocCache.set(`mockQuestions/${q.questionId}`, JSON.parse(JSON.stringify(q)));
            const write = {
                update: {
                    name: `${basePath}/mockQuestions/${q.questionId}`,
                    fields: this.toFirestoreFields(q)
                }
            };
            if (createOnly) {
                write.currentDocument = { exists: false };
                write._precheckExisted = false;
            }
            writes.push(write);

            // Compatibility write to existing exams/{examId}/years/{yearId}/papers/{paperId}/questions/{questionNumber}
            // CRITICAL PRODUCTION GUARD: ONLY execute for legitimate non-synthetic production imports!
            if (!isSynthetic && mockTest.examId && mockTest.year && mockTest.paperCode) {
                const legacyPath = `${basePath}/exams/${mockTest.examId}/years/${mockTest.year}/papers/${mockTest.paperCode}/questions/${q.questionNumber}`;
                writes.push({
                    update: {
                        name: legacyPath,
                        fields: this.toFirestoreFields({
                            questionNumber: q.questionNumber,
                            questionText: q.questionText,
                            options: (q.options || []).map(o => `(${o.label || o.id}) ${o.text}`),
                            questionType: q.questionType,
                            subject: q.subject,
                            topic: q.topic || "",
                            pageNumber: q.sourcePage || 1,
                            hasDiagram: Boolean(q.hasDiagram),
                            extractionStatus: "success",
                            createdAt: new Date().toISOString()
                        })
                    }
                });
            }
        }

        // 4. mockAnswerKeys/{answerKeyId} (PROTECTED)
        for (const ak of answerKeys) {
            const akId = ak.answerKeyId || ak.id || ak.questionId;
            if (createOnly && localDocCache.has(`mockAnswerKeys/${akId}`)) {
                throw new Error(`Document collision: Answer key ${akId} already exists in Firestore`);
            }
            localDocCache.set(`mockAnswerKeys/${akId}`, JSON.parse(JSON.stringify(ak)));
            const write = {
                update: {
                    name: `${basePath}/mockAnswerKeys/${akId}`,
                    fields: this.toFirestoreFields(ak)
                }
            };
            if (createOnly) {
                write.currentDocument = { exists: false };
                write._precheckExisted = false;
            }
            writes.push(write);
        }

        // 5. paperImportJobs/{jobId}
        if (job && job.jobId) {
            localDocCache.set(`paperImportJobs/${job.jobId}`, JSON.parse(JSON.stringify(job)));
            writes.push({
                update: {
                    name: `${basePath}/paperImportJobs/${job.jobId}`,
                    fields: this.toFirestoreFields(job)
                }
            });
        }

        return this.commitBatchWrites(writes, { ...options, projectId: targetProject });
    }
}
