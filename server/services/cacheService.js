import dotenv from "dotenv";
dotenv.config();

/**
 * In-Memory Server Cache with TTL, Bounded Stale Grace Period, LRU Eviction, and Rate Limiting
 * Configured via LIVE_UPDATES_CACHE_TTL_MINUTES (Default: 20 minutes)
 * Stale grace period configured via STALE_CACHE_GRACE_PERIOD_MINUTES (Default: 120 minutes)
 */
export class CacheService {
    static cache = new Map();
    static refreshTimestamps = new Map();
    static MAX_CACHE_ENTRIES = 100; // Strict maximum cache capacity

    /**
     * Default Cache TTL in milliseconds
     */
    static getTtlMs() {
        const minutes = parseInt(process.env.LIVE_UPDATES_CACHE_TTL_MINUTES || "20", 10);
        return Math.max(1, minutes) * 60 * 1000;
    }

    /**
     * Bounded Grace Period for Stale Retention in milliseconds
     * Stale fallback is only permitted within this grace window.
     */
    static getStaleGracePeriodMs() {
        const minutes = parseInt(process.env.STALE_CACHE_GRACE_PERIOD_MINUTES || "120", 10);
        return Math.max(5, minutes) * 60 * 1000;
    }

    /**
     * Get item from cache.
     * By default, returns null if the entry is expired.
     * If allowStale is true, returns the cached value ONLY within the bounded grace period.
     */
    static get(key, { allowStale = false } = {}) {
        const item = this.cache.get(key);
        if (!item) return null;

        const now = Date.now();
        const isFresh = now <= item.expiresAt;

        if (isFresh) {
            // Re-insert to refresh LRU access order
            this.cache.delete(key);
            this.cache.set(key, item);
            console.log(`[CacheService] Cache hit for key: "${key}" (expires in ${Math.round((item.expiresAt - now) / 1000)}s)`);
            return item.value;
        }

        if (allowStale) {
            const timeSinceExpiry = now - item.expiresAt;
            const gracePeriod = this.getStaleGracePeriodMs();

            if (timeSinceExpiry <= gracePeriod) {
                console.log(`[CacheService] Stale cache hit for key: "${key}" (expired ${Math.round(timeSinceExpiry / 1000)}s ago, within ${gracePeriod / 60000}m grace)`);
                return item.value;
            }

            // Exceeded bounded grace period: purge immediately
            console.log(`[CacheService] Stale cache entry for key: "${key}" exceeded ${gracePeriod / 60000}m grace period. Evicting.`);
            this.cache.delete(key);
            return null;
        }

        console.log(`[CacheService] Cache expired for key: "${key}"`);
        return null;
    }

    /**
     * Retrieve stale cached entry if present and within the bounded grace period
     */
    static getStale(key) {
        return this.get(key, { allowStale: true });
    }

    /**
     * Check if a valid fresh entry exists
     */
    static hasFresh(key) {
        const item = this.cache.get(key);
        if (!item) return false;
        return Date.now() <= item.expiresAt;
    }

    /**
     * Store item in cache with TTL and enforce strict MAX_CACHE_ENTRIES with LRU eviction
     */
    static set(key, value, ttlMinutes = null) {
        const ttlMs = ttlMinutes ? ttlMinutes * 60 * 1000 : this.getTtlMs();
        const now = Date.now();
        const expiresAt = now + ttlMs;

        // If key already exists, delete it so re-insert moves it to end (most recently used)
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // Enforce maximum cache size capacity with LRU eviction
        if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
            // First pass: purge entries whose bounded grace period has expired
            const gracePeriod = this.getStaleGracePeriodMs();
            for (const [k, v] of this.cache.entries()) {
                if (now - v.expiresAt > gracePeriod) {
                    this.cache.delete(k);
                }
            }

            // Second pass: if still at capacity, evict the oldest entry (FIFO/LRU)
            while (this.cache.size >= this.MAX_CACHE_ENTRIES) {
                const oldestKey = this.cache.keys().next().value;
                if (!oldestKey) break;
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, {
            value,
            createdAt: new Date().toISOString(),
            expiresAt
        });

        console.log(`[CacheService] Cache updated for key: "${key}" | TTL: ${ttlMs / 60000} mins | Capacity: ${this.cache.size}/${this.MAX_CACHE_ENTRIES}`);
    }

    /**
     * Check if client is rate-limited for forced manual refresh
     * Default: Max 1 forced refresh per 2 minutes per client IP/ID
     */
    static canClientRefresh(clientId) {
        const now = Date.now();
        const limitMs = parseInt(process.env.REFRESH_RATE_LIMIT_MINUTES || "2", 10) * 60 * 1000;
        const lastTime = this.refreshTimestamps.get(clientId) || 0;

        if (now - lastTime < limitMs) {
            const waitSecs = Math.ceil((limitMs - (now - lastTime)) / 1000);
            return {
                allowed: false,
                waitSecs,
                message: `Updates are already fresh. New search available in ${waitSecs} seconds.`
            };
        }

        this.refreshTimestamps.set(clientId, now);
        return { allowed: true };
    }

    /**
     * Invalidate specific key or all live updates cache
     */
    static invalidate(key = null) {
        if (key) {
            this.cache.delete(key);
            console.log(`[CacheService] Cache invalidated for key: "${key}"`);
        } else {
            this.cache.clear();
            console.log(`[CacheService] Entire cache cleared.`);
        }
    }
}
