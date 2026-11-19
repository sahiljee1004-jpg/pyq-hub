/**
 * VidyarthiAstra - Safe Local Firestore Emulator Seeder
 * 
 * Safely populates the local Firestore emulator (127.0.0.1:8088) with the
 * complete Study Resources catalog hierarchy matching the app schema.
 * 
 * Target: ONLY the local emulator (http://${FIRESTORE_EMULATOR_HOST})
 * Safety: NEVER touches or writes to production databases.
 */

import dotenv from "dotenv";
dotenv.config();

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8088";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";

if (!EMULATOR_HOST) {
    console.error("[ERROR] FIRESTORE_EMULATOR_HOST environment variable is not defined.");
    process.exit(1);
}

const BASE_URL = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

export const SEED_CATALOG = [
    // ------------------------------------------------------------
    // 1. COMPETITIVE EXAMS GS
    // ------------------------------------------------------------
    {
        type: "exam",
        path: "studyResources/COMPETITIVE EXAMS GS",
        fields: {
            name: { stringValue: "COMPETITIVE EXAMS GS" },
            order: { integerValue: "0" }
        }
    },
    {
        type: "subject",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY",
        fields: {
            name: { stringValue: "HISTORY" },
            order: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY/chapters/ANCIENT HISTORY",
        fields: {
            title: { stringValue: "ANCIENT HISTORY" },
            status: { stringValue: "published" },
            order: { integerValue: "0" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/sample.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY/chapters/ANCIENT HISTORY 1",
        fields: {
            title: { stringValue: "ANCIENT HISTORY 1" },
            status: { stringValue: "published" },
            order: { integerValue: "1" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/sample.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY/chapters/MEDIEVAL HISTORY",
        fields: {
            title: { stringValue: "MEDIEVAL HISTORY" },
            status: { stringValue: "published" },
            order: { integerValue: "2" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/sample.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY/chapters/MEDIEVAL HISTORY 1",
        fields: {
            title: { stringValue: "MEDIEVAL HISTORY 1" },
            status: { stringValue: "published" },
            order: { integerValue: "3" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/sample.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/COMPETITIVE EXAMS GS/subjects/HISTORY/chapters/MODERN HISTORY",
        fields: {
            title: { stringValue: "MODERN HISTORY" },
            status: { stringValue: "published" },
            order: { integerValue: "4" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/sample.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },

    // ------------------------------------------------------------
    // 2. JEE MAINS
    // ------------------------------------------------------------
    {
        type: "exam",
        path: "studyResources/Jee Mains",
        fields: {
            name: { stringValue: "Jee Mains" },
            order: { integerValue: "1" }
        }
    },

    // Chemistry Subject & Chapters
    {
        type: "subject",
        path: "studyResources/Jee Mains/subjects/chemistry",
        fields: {
            name: { stringValue: "Chemistry" },
            order: { integerValue: "1" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/atomic structure",
        fields: {
            title: { stringValue: "Atomic Structure" },
            status: { stringValue: "published" },
            order: { integerValue: "0" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Atomic_Structure_JEE_Notes_With_Topicwise_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/chemical bonding",
        fields: {
            title: { stringValue: "Chemical Bonding" },
            status: { stringValue: "published" },
            order: { integerValue: "1" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Chemical_Bonding_JEE_Notes_With_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/solution",
        fields: {
            title: { stringValue: "Solution" },
            status: { stringValue: "published" },
            order: { integerValue: "2" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Solutions_JEE_Notes_With_Topicwise_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/solid state",
        fields: {
            title: { stringValue: "Solid State" },
            status: { stringValue: "published" },
            order: { integerValue: "3" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Solid_State_Notes_With_Topicwise_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/gaseous state",
        fields: {
            title: { stringValue: "Gaseous State" },
            status: { stringValue: "published" },
            order: { integerValue: "4" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Gaseous_State_Notes_With_Topicwise_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/nuclear chemistry",
        fields: {
            title: { stringValue: "Nuclear Chemistry" },
            status: { stringValue: "published" },
            order: { integerValue: "5" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Nuclear_Chemistry_Notes_With_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/chemical equalibrium",
        fields: {
            title: { stringValue: "Chemical Equilibrium" },
            status: { stringValue: "published" },
            order: { integerValue: "6" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Chemical_Equilibrium_JEE_Notes_With_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/ionic equalibrium",
        fields: {
            title: { stringValue: "Ionic Equalibrium" },
            status: { stringValue: "published" },
            order: { integerValue: "7" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Ionic_Equilibrium_JEE_Notes_With_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/chemistry/chapters/thermodynamics and thermochemistry",
        fields: {
            title: { stringValue: "Thermodynamics and Thermochemistry" },
            status: { stringValue: "published" },
            order: { integerValue: "8" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Thermodynamics_Thermochemistry_JEE_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },

    // Physics Subject & Chapters
    {
        type: "subject",
        path: "studyResources/Jee Mains/subjects/physics",
        fields: {
            name: { stringValue: "Physics" },
            order: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/mathematics-in-physics",
        fields: {
            title: { stringValue: "Mathematics In Physics" },
            status: { stringValue: "published" },
            order: { integerValue: "0" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/mathematics_in_physics.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/units and dimension",
        fields: {
            title: { stringValue: "Units And Dimensions" },
            status: { stringValue: "published" },
            order: { integerValue: "1" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Units_and_Dimensions_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/motion in one plane",
        fields: {
            title: { stringValue: "Motion In One Dimension" },
            status: { stringValue: "published" },
            order: { integerValue: "2" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Motion_in_One_Dimension_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/motion in 2-Dimension",
        fields: {
            title: { stringValue: "Motion In 2-Dimension" },
            status: { stringValue: "published" },
            order: { integerValue: "3" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Motion_in_Two_Dimensions_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/newtons law of motion",
        fields: {
            title: { stringValue: "Newton's Law of Motion" },
            status: { stringValue: "published" },
            order: { integerValue: "5" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Newtons_Laws_of_Motion_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/friction",
        fields: {
            title: { stringValue: "Friction" },
            status: { stringValue: "published" },
            order: { integerValue: "6" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Friction_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/rotational motion",
        fields: {
            title: { stringValue: "Rotational Motion" },
            status: { stringValue: "published" },
            order: { integerValue: "7" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Rotational_Motion_JEE_Short_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/work,energy,power and collsion",
        fields: {
            title: { stringValue: "Work,Power,Energy and Collsion" },
            status: { stringValue: "published" },
            order: { integerValue: "7" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Work_Energy_Power_Collisions_JEE_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/gravitation",
        fields: {
            title: { stringValue: "Gravitation" },
            status: { stringValue: "published" },
            order: { integerValue: "8" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Gravitation_JEE_Notes_With_Topicwise_Examples.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/kinetic theory of gases",
        fields: {
            title: { stringValue: "Kinetic Theory of Gases" },
            status: { stringValue: "published" },
            order: { integerValue: "9" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Kinetic_Theory_of_Gases_JEE_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/thermometry,thermo expansion,calorimetry",
        fields: {
            title: { stringValue: "Thermometry, Thermal Expansion and calorimetry" },
            status: { stringValue: "published" },
            order: { integerValue: "10" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Thermometry_Thermal_Expansion_Calorimetry_JEE_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    },
    {
        type: "chapter",
        path: "studyResources/Jee Mains/subjects/physics/chapters/shm",
        fields: {
            title: { stringValue: "Simple Harmonic Motion" },
            status: { stringValue: "published" },
            order: { integerValue: "11" },
            pdfUrl: { stringValue: "https://res.cloudinary.com/q3nxxjg8/image/upload/Simple_Harmonic_Motion_JEE_Notes.pdf" },
            viewCount: { integerValue: "0" },
            downloadCount: { integerValue: "0" }
        }
    }
];

export async function seedEmulatorStudyResources(quiet = false) {
    if (!quiet) {
        console.log("==================================================");
        console.log("  SEEDING LOCAL FIRESTORE EMULATOR STUDY CATALOG  ");
        console.log(`  Host:    ${EMULATOR_HOST}`);
        console.log(`  Project: ${PROJECT_ID}`);
        console.log(`  Items:   ${SEED_CATALOG.length} documents`);
        console.log("==================================================");
    }

    // 1. Health check to ensure emulator is active
    try {
        const ping = await fetch(`http://${EMULATOR_HOST}/`);
        if (!ping.ok && ping.status !== 200) {
            throw new Error(`Emulator ping returned status ${ping.status}`);
        }
    } catch (err) {
        console.error(`[ERROR] Cannot connect to Firestore Emulator at http://${EMULATOR_HOST}. Is it running? (${err.message})`);
        return false;
    }

    // 2. Seed catalog documents safely using Bearer owner
    let seededCount = 0;
    for (const item of SEED_CATALOG) {
        const encodedPath = item.path.split("/").map(encodeURIComponent).join("/");
        const docUrl = `${BASE_URL}/${encodedPath}`;

        const res = await fetch(docUrl, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer owner"
            },
            body: JSON.stringify({ fields: item.fields })
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[FAIL] Could not seed ${item.path}: HTTP ${res.status} - ${errText}`);
            return false;
        }

        seededCount++;
        if (!quiet) {
            console.log(`  [OK] (${seededCount}/${SEED_CATALOG.length}) Seeded ${item.type.padEnd(8)} -> ${item.path}`);
        }
    }

    if (!quiet) {
        console.log("==================================================");
        console.log(`  EMULATOR SEED COMPLETED: ${seededCount} documents!`);
        console.log("==================================================");
    }
    return true;
}

// Run directly if invoked from command line
if (process.argv[1] && process.argv[1].endsWith("seed-emulator-study-resources.js")) {
    seedEmulatorStudyResources().then((ok) => {
        process.exitCode = ok ? 0 : 1;
    });
}
