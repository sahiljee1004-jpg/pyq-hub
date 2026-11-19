import app from "./app.js";
import { startServer } from "../server.js";

// Check if running in an automated test environment
const isTestEnv = process.env.NODE_ENV === "test" ||
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test")) ||
    (Array.isArray(process.argv) && process.argv.some(a => typeof a === "string" && (a.includes("test") || a.includes("mocha") || a.includes("jest"))));

// If Hostinger's hPanel startup file is pointed to server/server.js, ensure server starts immediately
if (!isTestEnv) {
    startServer();
}

// Re-export Express application instance for test suites and programmatic importers
export { app };
export default app;
