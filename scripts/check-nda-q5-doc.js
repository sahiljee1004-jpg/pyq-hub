import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

async function checkDoc() {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
        throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS environment variable.");
    }
    const sa = JSON.parse(fs.readFileSync(credPath, "utf8"));
    initializeApp({ credential: cert(sa) });
    const db = getFirestore();
    const docSnap = await db.doc("exams/NDA/years/2025/papers/nda math/questions/5").get();
    console.log("NDA Q5 Document data:", JSON.stringify(docSnap.data(), null, 2));
}

checkDoc();
