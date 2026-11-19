import express from "express";
import assert from "node:assert/strict";
import liveUpdatesRouter from "../server/routes/liveUpdates.js";
import { SearchService } from "../server/services/searchService.js";
import { CacheService } from "../server/services/cacheService.js";

async function runE2EVerification() {
    console.log("==================================================");
    console.log("STARTING LIVE UPDATES & SEARCH ROUTE E2E VERIFICATION");
    console.log("==================================================");

    const app = express();
    app.use(express.json());

    // Health endpoints
    app.get(["/health", "/api/health"], (req, res) => {
        res.json({
            success: true,
            service: "VidyarthiAstra AI Assistant backend",
            primarySearchProvider: SearchService.getPrimaryProviderName(),
            secondarySearchProvider: SearchService.getSecondaryProviderName(),
            fallbackEnabled: SearchService.isFallbackEnabled(),
            tinyfishConfigured: Boolean(process.env.TINYFISH_API_KEY),
            serperConfigured: SearchService.isSerperConfigured()
        });
    });

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

    app.use("/api/live-updates", liveUpdatesRouter);

    const server = app.listen(3099, "127.0.0.1");

    try {
        const baseUrl = "http://127.0.0.1:3099";

        // TEST 1: Health endpoint contract
        console.log("\n[E2E 1] Testing /health contract...");
        const resHealth = await fetch(`${baseUrl}/health`);
        const jsonHealth = await resHealth.json();
        assert.equal(resHealth.status, 200);
        assert.equal(jsonHealth.primarySearchProvider, "tinyfish");
        assert.equal(jsonHealth.secondarySearchProvider, "serper");
        console.log("✔ /health returned expected contract:", JSON.stringify(jsonHealth));

        // TEST 2: /api/search/health endpoint
        console.log("\n[E2E 2] Testing /api/search/health contract...");
        const resSearchHealth = await fetch(`${baseUrl}/api/search/health`);
        const jsonSearchHealth = await resSearchHealth.json();
        assert.equal(resSearchHealth.status, 200);
        assert.equal(jsonSearchHealth.primaryProvider, "tinyfish");
        assert.equal(jsonSearchHealth.secondaryProvider, "serper");
        console.log("✔ /api/search/health returned expected contract:", JSON.stringify(jsonSearchHealth));

        // TEST 3: Empty search query validation
        console.log("\n[E2E 3] Testing empty search query validation...");
        const resEmpty = await fetch(`${baseUrl}/api/live-updates/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "" })
        });
        const jsonEmpty = await resEmpty.json();
        assert.equal(resEmpty.status, 400);
        assert.equal(jsonEmpty.success, false);
        console.log("✔ Empty search query rejected with HTTP 400:", jsonEmpty.error);

        // TEST 4: Live Updates Search with Mocked Provider (Cached feed returned)
        console.log("\n[E2E 4] Testing Live Updates Search query with pre-cached feed...");
        const testQuery = "GATE 2027 Notification";
        const normalizedKey = `live_updates:search:gate_2027_notification`;
        CacheService.set(normalizedKey, {
            success: true,
            query: testQuery,
            cached: false,
            lastUpdated: new Date().toISOString(),
            updates: [{
                id: "gate_2027_test_card",
                examName: "GATE 2027",
                category: "ENGINEERING",
                updateType: "IMPORTANT_NOTIFICATION",
                title: "GATE 2027 Registration Portal Opened",
                summary: "Application portal is now live.",
                importantDate: "15 Oct 2026",
                status: "active",
                publishedAt: "2026-10-16",
                source: {
                    title: "IIT Madras Official",
                    url: "https://gate2027.iitm.ac.in",
                    domain: "gate2027.iitm.ac.in",
                    type: "official"
                }
            }]
        }, 15);

        const resSearch = await fetch(`${baseUrl}/api/live-updates/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: testQuery })
        });
        const jsonSearch = await resSearch.json();
        assert.equal(resSearch.status, 200);
        assert.equal(jsonSearch.success, true);
        assert.equal(jsonSearch.updates.length, 1);
        assert.equal(jsonSearch.updates[0].examName, "GATE 2027");
        console.log("✔ /api/live-updates/search returned structured updates:", jsonSearch.updates[0].title);

        // TEST 5: Category Filtering
        console.log("\n[E2E 5] Testing category filtering on search endpoint...");
        const resMedicalFilter = await fetch(`${baseUrl}/api/live-updates/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: testQuery, category: "MEDICAL" })
        });
        const jsonMedical = await resMedicalFilter.json();
        assert.equal(resMedicalFilter.status, 200);
        assert.equal(jsonMedical.updates.length, 0, "GATE card should be filtered out by MEDICAL category filter");
        console.log("✔ Category filtering operates correctly on live updates endpoint");

        console.log("\n==================================================");
        console.log("ALL E2E ROUTE CHECKS PASSED SUCCESSFULLY (5/5)");
        console.log("==================================================");

    } finally {
        server.close();
    }
}

runE2EVerification().catch((err) => {
    console.error("E2E Verification Error:", err);
    process.exit(1);
});
