// ============================================================
// VIDYARTHIASTRA — CENTRALIZED API CONFIGURATION & URL RESOLVER
// Supports Web (Hostinger VPS Node.js & Local), Android Capacitor (Native & USB Dev)
// ============================================================

export function getApiBaseUrl() {
    // 1. Check if running inside Capacitor Android native app
    const isCapacitorNative =
        typeof window !== "undefined" &&
        window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === "function" &&
        window.Capacitor.isNativePlatform();

    if (isCapacitorNative) {
        // Native Capacitor Android App environment
        if (window.VIDYARTHIVERSE_API_URL) {
            return window.VIDYARTHIVERSE_API_URL.replace(/\/+$/, "");
        }
        // Native USB / Emulator reverse proxy default
        return "http://127.0.0.1:3000";
    }

    // 2. Web Browser environment (Hostinger VPS Production, Localhost, or custom host)
    // Relative paths work automatically for same-origin Web deployments (Hostinger VPS / Express)
    return "";
}

export function getApiUrl(endpoint) {
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const base = getApiBaseUrl();
    return `${base}${cleanEndpoint}`;
}

if (typeof window !== "undefined") {
    window.getApiBaseUrl = getApiBaseUrl;
    window.getApiUrl = getApiUrl;
}
