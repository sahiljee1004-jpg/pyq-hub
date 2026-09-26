// ============================================================
// PYQs HUB — EXAM PAGE
// FIRESTORE → EXAM → YEARS
// ============================================================

import {
    db
} from "./firebase.js";

import {
    doc,
    getDoc,
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import { sortYearsDescending } from "./sorting.js";


// ============================================================
// ELEMENTS
// ============================================================

const examTitle =
    document.getElementById("examTitle");

const examDescription =
    document.getElementById("examDescription");

const yearGrid =
    document.getElementById("yearGrid");

const yearCount =
    document.getElementById("yearCount");

const footerYear =
    document.getElementById("year");


// ============================================================
// FOOTER YEAR
// ============================================================

if (footerYear) {

    footerYear.textContent =
        new Date().getFullYear();

}


// ============================================================
// GET EXAM ID FROM URL
// ============================================================
//
// Example:
//
// exam.html?id=jee-main
//
// Result:
//
// examId = "jee-main"
//

const urlParams =
    new URLSearchParams(
        window.location.search
    );

const examId =
    urlParams.get("id");


// ============================================================
// CHECK EXAM ID
// ============================================================

if (!examId) {

    showError(
        "No exam was selected."
    );

} else {

    loadExam();

}


// ============================================================
// LOAD EXAM
// ============================================================

async function loadExam() {

    try {

        // ====================================================
        // EXAM DOCUMENT
        // ====================================================

        const examRef =
            doc(
                db,
                "exams",
                examId
            );


        const examSnapshot =
            await getDoc(
                examRef
            );


        // ====================================================
        // EXAM NOT FOUND
        // ====================================================

        if (!examSnapshot.exists()) {

            showError(
                "Exam not found."
            );

            return;

        }


        // ====================================================
        // EXAM DATA
        // ====================================================

        const exam =
            examSnapshot.data();


        const examName =
            exam.name ||
            exam.title ||
            formatName(examId);


        const description =
            exam.description ||
            "Previous year question papers";


        // ====================================================
        // DISPLAY EXAM
        // ====================================================

        examTitle.textContent =
            examName;

        examDescription.textContent =
            description;


        // ====================================================
        // LOAD YEARS
        // ====================================================

        await loadYears();


    } catch (error) {

        console.error(
            "Error loading exam:",
            error
        );


        showError(
            "Unable to load this exam."
        );

    }

}


// ============================================================
// LOAD YEARS
// ============================================================
//
// Firestore structure:
//
// exams
//   └── jee-main
//        └── years
//             ├── 2026
//             ├── 2025
//             ├── 2024
//             └── 2023
//

async function loadYears() {

    try {

        yearGrid.innerHTML = `
            <div class="loading">
                Loading years...
            </div>
        `;


        const yearsRef =
            collection(
                db,
                "exams",
                examId,
                "years"
            );


        onSnapshot(
            yearsRef,
            (snapshot) => {
                const years = sortYearsDescending(
                    snapshot.docs.map((yearDocument) => ({
                        id: yearDocument.id,
                        ...yearDocument.data()
                    }))
                );


        // ====================================================
        // UPDATE COUNT
        // ====================================================

        if (yearCount) {

            if (years.length === 1) {

                yearCount.textContent =
                    "1 year";

            } else {

                yearCount.textContent =
                    `${years.length} years`;

            }

        }


        // ====================================================
        // NO YEARS
        // ====================================================

        if (!years.length) {

            yearGrid.innerHTML = `
                <div class="empty-message">

                    No previous year papers
                    are available yet.

                </div>
            `;

            return;

        }


        // ====================================================
        // DISPLAY YEARS
        // ====================================================

        yearGrid.innerHTML = "";


        years.forEach(
            (yearData) => {

                const card =
                    document.createElement(
                        "a"
                    );


                card.className =
                    "year-card";


                const yearName =
                    yearData.year ||
                    yearData.id;


                card.href =
                    `papers.html?exam=${encodeURIComponent(examId)}&year=${encodeURIComponent(yearData.id)}`;


                card.innerHTML = `

                    <div class="year-number">

                        ${escapeHTML(
                            yearName
                        )}

                    </div>

                    <div class="year-text">

                        View Papers →

                    </div>

                `;


                yearGrid.appendChild(
                    card
                );

            }
                );
            },
            (error) => {
                console.error("Error loading years:", error);
                yearGrid.innerHTML = `
                    <div class="error-message">
                        Unable to load years.
                    </div>
                `;
            }
        );

    } catch (error) {

        console.error(
            "Error loading years:",
            error
        );


        yearGrid.innerHTML = `
            <div class="error-message">

                Unable to load years.

            </div>
        `;

    }

}


// ============================================================
// ERROR
// ============================================================

function showError(message) {

    if (examTitle) {

        examTitle.textContent =
            "Something went wrong";

    }


    if (examDescription) {

        examDescription.textContent =
            message;

    }


    if (yearGrid) {

        yearGrid.innerHTML = "";

    }


    if (yearCount) {

        yearCount.textContent =
            "";

    }

}


// ============================================================
// FORMAT EXAM NAME
// ============================================================

function formatName(id) {

    return String(id)
        .replace(
            /[-_]+/g,
            " "
        )
        .replace(
            /\b\w/g,
            character =>
                character.toUpperCase()
        );

}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(value) {

    return String(value)
        .replace(
            /[&<>"']/g,
            character => {

                const characters = {

                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#039;"

                };

                return characters[
                    character
                ];

            }
        );

}