import dotenv from "dotenv";
import app from "./server/app.js";
import { SearchService } from "./server/services/searchService.js";

// Load environment variables from .env file
dotenv.config();

// Step 4 diagnostics: Log process startup info safely (never credentials or API keys)
console.log(`[BOOT] VidyarthiAstra startup initiated`);
console.log(`[BOOT] argv:`, JSON.stringify(process.argv));
console.log(`[BOOT] cwd: ${process.cwd()}`);
console.log(`[BOOT] NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
console.log(`[BOOT] PORT defined: ${Boolean(process.env.PORT)}`);
if (process.env.PORT) {
    const isNum = !isNaN(Number(process.env.PORT));
    console.log(`[BOOT] PORT type: ${isNum ? "numeric TCP" : "socket/string"}, value: ${isNum ? process.env.PORT : "[SOCKET PATH OMITTED]"}`);
} else {
    console.log(`[BOOT] Defaulting PORT to 3000`);
}
console.log(`[STAGE 1] Loaded environment and application modules.`);

// Catch unhandled errors at process level to aid Hostinger diagnostics
process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[CRITICAL] Unhandled rejection at:", promise, "reason:", reason);
});

let isServerStarted = false;
let globalServer = null;

function onServerStarted() {
    const rawPort = process.env.PORT || 3000;
    const isUnixSocket = typeof rawPort === "string" && isNaN(Number(rawPort));
    const groqStatus = (process.env.AI_API_KEY || process.env.GROQ_API_KEY) ? "Configured" : "Not Set";
    const primarySearch = SearchService.getPrimaryProviderName();
    const secondarySearch = SearchService.getSecondaryProviderName();
    const tinyfishStatus = process.env.TINYFISH_API_KEY ? "Configured" : "Not Set";
    const serperStatus = SearchService.isSerperConfigured() ? "Configured" : "Not Set";
    const fallbackStatus = SearchService.isFallbackEnabled() ? "Enabled" : "Disabled";

    console.log(`====================================================`);
    console.log(`🚀 VidyarthiAstra Server listening on ${isUnixSocket ? "[UNIX SOCKET/IPC PIPE]" : `port ${rawPort}`}`);
    console.log(`   Environment:      ${process.env.NODE_ENV || "development"}`);
    console.log(`   Architecture:     TinyFish Search/Fetch + Serper Fallback + Groq AI + Live Updates`);
    console.log(`   Model:            ${process.env.AI_MODEL || "openai/gpt-oss-120b"}`);
    console.log(`   Primary Search:   ${primarySearch.toUpperCase()}`);
    console.log(`   Secondary Search: ${secondarySearch.toUpperCase()}`);
    console.log(`   Fallback Status:  ${fallbackStatus}`);
    console.log(`   TinyFish Status:  ${tinyfishStatus}`);
    console.log(`   Serper Status:    ${serperStatus}`);
    console.log(`   Groq Status:      ${groqStatus}`);
    console.log(`   Cache TTL:        ${process.env.LIVE_UPDATES_CACHE_TTL_MINUTES || "20"} mins`);
    console.log(`====================================================`);
}

export function startServer() {
    if (isServerStarted) {
        return globalServer;
    }
    isServerStarted = true;

    const rawPort = process.env.PORT || 3000;
    const port = !isNaN(Number(rawPort)) ? Number(rawPort) : rawPort;

    console.log(`[STAGE 2] Registering HTTP listener on ${typeof port === "number" ? `port ${port}` : "socket path"}...`);

    // Standard Express app.listen(port, callback) universally supported by Node, Express, Passenger & Hostinger
    globalServer = app.listen(port, onServerStarted);

    globalServer.on("listening", () => {
        const addr = globalServer.address();
        const bind = typeof addr === "string" ? "unix domain socket / IPC pipe" : `port ${addr ? addr.port : port}`;
        console.log(`[STAGE 3] HTTP listener successfully registered and listening on ${bind}`);
    });

    globalServer.on("error", (err) => {
        console.error(`[STAGE 3 ERROR] Server failed to bind:`, err);
    });

    return globalServer;
}

// Check if running in a test environment
const isTestEnv = process.env.NODE_ENV === "test" ||
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test")) ||
    (Array.isArray(process.argv) && process.argv.some(a => typeof a === "string" && (a.includes("test") || a.includes("mocha") || a.includes("jest"))));

// Auto-start listener if not in a test environment
if (!isTestEnv) {
    startServer();
}

export { app, globalServer as server };
export default globalServer || app;
