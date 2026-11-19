import express from "express";
import { LiveUpdatesService } from "../services/liveUpdatesService.js";
import { ResponseService } from "../services/responseService.js";

const router = express.Router();

/**
 * Helper to get client identifier for rate-limiting
 */
function getClientId(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.split("Bearer ")[1].substring(0, 20);
    }
    return req.ip || req.headers["x-forwarded-for"] || "anonymous_client";
}

/**
 * GET /api/live-updates & POST /api/live-updates
 * Retrieve recent & active live exam updates feed
 */
const handleGetUpdates = async (req, res) => {
    try {
        const category = req.query.category || req.body?.category || "ALL";
        const forceRefresh = req.query.refresh === "true" || req.body?.forceRefresh === true;
        const clientId = getClientId(req);

        console.log(`[API /api/live-updates] Request received | category=${category} | forceRefresh=${forceRefresh}`);

        const result = await LiveUpdatesService.getLiveUpdates({
            forceRefresh,
            category,
            clientId
        });

        if (result.rateLimited && !result.success) {
            return res.status(429).json(result);
        }

        return res.json(result);

    } catch (err) {
        console.error("[API /api/live-updates Exception]:", err);
        const errRes = ResponseService.buildErrorResponse(
            "Live Updates service is temporarily unavailable. Please try again in a few moments.",
            500
        );
        return res.status(errRes.statusCode).json(errRes.payload);
    }
};

router.get("/", handleGetUpdates);
router.post("/", handleGetUpdates);

/**
 * POST /api/live-updates/refresh
 * Force-refresh feed with rate limiting
 */
router.post("/refresh", async (req, res) => {
    try {
        const category = req.body?.category || "ALL";
        const clientId = getClientId(req);

        console.log(`[API /api/live-updates/refresh] Forced refresh requested by ${clientId}`);

        const result = await LiveUpdatesService.getLiveUpdates({
            forceRefresh: true,
            category,
            clientId
        });

        if (result.rateLimited && !result.success) {
            return res.status(429).json(result);
        }

        return res.json(result);

    } catch (err) {
        console.error("[API /api/live-updates/refresh Exception]:", err);
        return res.status(500).json({
            success: false,
            error: "Unable to refresh live updates right now. Please try again."
        });
    }
});

/**
 * GET /api/live-updates/search & POST /api/live-updates/search
 * Search exam updates by query (e.g. "GATE 2027" or "JEE Main registration last date")
 */
const handleSearchUpdates = async (req, res) => {
    try {
        const query = req.query.q || req.body?.q || req.body?.query || "";
        const category = req.query.category || req.body?.category || "ALL";

        console.log(`[API /api/live-updates/search] Search query: "${query}" | category=${category}`);

        if (!query || typeof query !== "string" || query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: "Please enter an exam name or topic to search."
            });
        }

        const result = await LiveUpdatesService.searchLiveUpdates(query.trim(), { category });
        return res.json(result);

    } catch (err) {
        console.error("[API /api/live-updates/search Exception]:", err);
        return res.status(500).json({
            success: false,
            error: "Unable to complete search request right now. Please try again."
        });
    }
};

router.get("/search", handleSearchUpdates);
router.post("/search", handleSearchUpdates);

export default router;
