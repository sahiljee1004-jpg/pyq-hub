import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chatHandler } from "./routes/chat.js";
import liveUpdatesRouter from "./routes/liveUpdates.js";
import papersRouter from "./routes/papers.js";
import studyResourcesRouter from "./routes/studyResources.js";
import adminRouter from "./routes/admin.js";
import authRouter from "./routes/auth.js";
import mockTestsRouter from "./routes/mockTests.js";
import foundersRouter from "./routes/founders.js";
import { AdminAuthService } from "./services/admin/adminAuthService.js";
import { SearchService } from "./services/searchService.js";

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parse HTTP cookies
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(";").forEach(c => {
            const [name, ...val] = c.split("=");
            if (name) {
                req.cookies[name.trim()] = val.join("=").trim();
            }
        });
    }
    next();
});

// Enable HTTP Security Headers & Body Parsing Limits
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
});

// Configure CORS: explicit production allowlist with fallback for mobile apps and same-origin requests
const defaultProductionOrigins = [
    "https://vidyarthiastra.in",
    "https://www.vidyarthiastra.in"
];

const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
    : process.env.NODE_ENV === "production" ? defaultProductionOrigins : null;

const corsMiddleware = cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, native Capacitor, server-to-server)
        if (!origin) return callback(null, true);
        // Allow Capacitor & local dev origins
        if (origin === "capacitor://localhost"
            || origin === "http://localhost"
            || origin.startsWith("http://localhost:")
            || origin === "https://localhost"
            || origin.startsWith("https://localhost:")
            || origin === "http://127.0.0.1"
            || origin.startsWith("http://127.0.0.1:")
            || origin === "https://127.0.0.1"
            || origin.startsWith("https://127.0.0.1:")) {
            return callback(null, true);
        }
        if (allowedOrigins === null || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key", "X-API-Key"]
});

app.use((req, res, next) => {
    const origin = req.get("origin");
    const requestHost = req.get("host");
    if (origin && requestHost) {
        try {
            if (new URL(origin).host.toLowerCase() === requestHost.toLowerCase()) {
                return next();
            }
        } catch (error) {}
    }
    return corsMiddleware(req, res, next);
});

// Configure JSON Body Limits (50MB for admin PDF imports, 1MB default for public routes to prevent DoS)
app.use((req, res, next) => {
    if (req.path.startsWith("/api/admin")) {
        return express.json({ limit: "50mb" })(req, res, next);
    }
    if (req.path.startsWith("/api/founders")) {
        return express.json({ limit: "8mb" })(req, res, next);
    }
    return express.json({ limit: "1mb" })(req, res, next);
});

// Health Check Endpoints
app.get(["/health", "/api/health"], (req, res) => {
    const hasGroq = Boolean(process.env.AI_API_KEY || process.env.GROQ_API_KEY);
    const hasTinyfish = Boolean(process.env.TINYFISH_API_KEY);
    const hasSerper = SearchService.isSerperConfigured();

    res.json({
        success: true,
        service: "VidyarthiAstra AI Assistant backend",
        architecture: "TinyFish Search/Fetch + Serper Google Search Fallback + Groq AI Tutor + Live Updates Engine",
        primarySearchProvider: SearchService.getPrimaryProviderName(),
        secondarySearchProvider: SearchService.getSecondaryProviderName(),
        fallbackEnabled: SearchService.isFallbackEnabled(),
        tinyfishConfigured: hasTinyfish,
        serperConfigured: hasSerper,
        groqConfigured: hasGroq,
        model: process.env.AI_MODEL || "openai/gpt-oss-120b",
        cacheTtlMinutes: parseInt(process.env.LIVE_UPDATES_CACHE_TTL_MINUTES || "20", 10),
        timestamp: new Date().toISOString()
    });
});

// Dedicated Search Engine Health Endpoint
app.get("/api/search/health", (req, res) => {
    res.json({
        success: true,
        primaryProvider: SearchService.getPrimaryProviderName(),
        secondaryProvider: SearchService.getSecondaryProviderName(),
        fallbackEnabled: SearchService.isFallbackEnabled(),
        tinyfishConfigured: Boolean(process.env.TINYFISH_API_KEY),
        serperConfigured: SearchService.isSerperConfigured()
    });
});

// Search Test Endpoint (Development Diagnostic - Disabled in Production)
app.get("/api/search/test", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(403).json({ success: false, error: "Diagnostic test endpoints are disabled in production." });
    }
    try {
        const query = req.query.q || "JEE Main 2026 notification";
        const results = await SearchService.searchWeb(query, { num: 5 });
        res.json(results);
    } catch (err) {
        console.error("[Diagnostic Search Error]:", err.message);
        res.status(500).json({ success: false, error: "Search diagnostic execution failed." });
    }
});

// Bind Primary Chat Route Handlers
app.post("/api/chat", chatHandler);
app.post("/api/ai-chat", chatHandler);

// Bind Live Updates Route Handlers
app.use("/api/live-updates", liveUpdatesRouter);

// Bind Paper Counter Operations Route Handlers
app.use("/api/papers", papersRouter);

// Bind Study Resources Counter Operations Route Handlers
app.use("/api/study-resources", studyResourcesRouter);

// Bind Admin Dashboard & PYQ Import Pipeline Route Handlers
app.use("/api/admin", adminRouter);

// Bind Authentication & Session Route Handlers
app.use("/api/auth", authRouter);

// Bind Student Mock Test Engine Route Handlers
app.use("/api/mock-tests", mockTestsRouter);

// Public founder profiles and admin-verified founder updates
app.use("/api/founders", foundersRouter);

// Dedicated Protected Admin Dashboard Route — Enforces server-side authorization before static files
const protectedAdminHtmlPath = path.join(__dirname, "views/admin.html");
app.get(["/admin.html", "/admin"], AdminAuthService.protectAdminPage(), (req, res) => {
    res.sendFile(protectedAdminHtmlPath);
});

// Serve static frontend assets from www directory (for Hostinger & monolithic deployment)
const wwwPath = path.join(__dirname, "../www");
app.use(express.static(wwwPath, { extensions: ["html"] }));

// Fallback to index.html for non-API web navigation
app.get("*", (req, res) => {
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/health") && !req.path.startsWith("/admin")) {
        res.sendFile(path.join(wwwPath, "index.html"));
    }
});

export { app };
export default app;

