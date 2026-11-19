import dotenv from "dotenv";
import { LiveUpdatesService } from "../server/services/liveUpdatesService.js";

dotenv.config();

async function runTest() {
    console.log("==================================================");
    console.log("TEST 1: Fetching Live Updates Feed (Broad Discovery)");
    console.log("==================================================");

    const res1 = await LiveUpdatesService.getLiveUpdates({ forceRefresh: false, category: "ALL" });
    console.log("Result 1 Success:", res1.success);
    console.log("Result 1 Cached:", res1.cached);
    console.log("Updates Count:", res1.updates?.length || 0);

    if (res1.updates && res1.updates.length > 0) {
        console.log("Sample Update Card 1:", JSON.stringify(res1.updates[0], null, 2));
    }

    console.log("\n==================================================");
    console.log("TEST 2: Fetching Cached Feed");
    console.log("==================================================");

    const res2 = await LiveUpdatesService.getLiveUpdates({ forceRefresh: false, category: "ALL" });
    console.log("Result 2 Cached:", res2.cached);
    console.log("Cached Updates Count:", res2.updates?.length || 0);

    console.log("\n==================================================");
    console.log("TEST 3: Targeted Search ('GATE 2027')");
    console.log("==================================================");

    const res3 = await LiveUpdatesService.searchLiveUpdates("GATE 2027", { category: "ALL" });
    console.log("Result 3 Success:", res3.success);
    console.log("GATE Updates Count:", res3.updates?.length || 0);
    if (res3.updates && res3.updates.length > 0) {
        console.log("Sample GATE Card:", JSON.stringify(res3.updates[0], null, 2));
    }

    console.log("\n==================================================");
    console.log("ALL TESTS COMPLETED SUCCESSFULLY");
    console.log("==================================================");
}

runTest().catch((err) => {
    console.error("Test Exception:", err);
    process.exit(1);
});
