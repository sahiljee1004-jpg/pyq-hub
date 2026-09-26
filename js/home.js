// ============================================================
// PYQs HUB — HOME PAGE
// FIRESTORE EXAMS + SEARCH
// ============================================================

import {
    db
} from "./firebase.js";

import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import { sortExams } from "./sorting.js";


// ============================================================
// ELEMENTS
// ============================================================

const examGrid =
    document.getElementById("examGrid");

const searchInput =
    document.getElementById("searchInput");

const searchButton =
    document.getElementById("searchButton");

const examCount =
    document.getElementById("examCount");

const year =
    document.getElementById("year");


// ============================================================
// FOOTER YEAR
// ============================================================

if (year) {

    year.textContent =
        new Date().getFullYear();

}


// ============================================================
// STORE EXAMS
// ============================================================

let allExams = [];


// ============================================================
// LOAD EXAMS FROM FIRESTORE
// ============================================================

async function loadExams() {

    try {

        examGrid.innerHTML = `
            <div class="loading">
                Loading exams...
            </div>
        `;


        const examsRef =
            collection(
                db,
                "exams"
            );


        onSnapshot(
            examsRef,
            (snapshot) => {
                allExams = sortExams(
                    snapshot.docs.map((documentSnapshot) => ({
                        id: documentSnapshot.id,
                        ...documentSnapshot.data()
                    }))
                );

                const query = searchInput?.value.trim();
                const visibleExams = query
                    ? allExams.filter((exam) => {
                        const name = String(
                            exam.name || exam.title || exam.examName || exam.id || ""
                        ).toLowerCase();
                        const description = String(exam.description || "").toLowerCase();
                        return name.includes(query.toLowerCase()) ||
                            description.includes(query.toLowerCase());
                    })
                    : allExams;

                updateExamCount(visibleExams.length);
                displayExams(visibleExams);
            },
            (error) => {
                console.error("Error loading exams:", error);
                examGrid.innerHTML = `
                    <div class="error-message">
                        <strong>Unable to load exams.</strong>
                        <br>
                        ${escapeHTML(error.message)}
                    </div>
                `;
                if (examCount) {
                    examCount.textContent = "Error";
                }
            }
        );


    } catch (error) {
        console.error("Error loading exams:", error);
        examGrid.innerHTML = `
            <div class="error-message">
                <strong>Unable to load exams.</strong>
                <br>
                ${escapeHTML(error.message)}
            </div>
        `;
        if (examCount) {
            examCount.textContent = "Error";
        }
    }

}


// ============================================================
// DISPLAY EXAMS
// ============================================================

function displayExams(exams) {

    if (!exams.length) {

        examGrid.innerHTML = `
            <div class="empty-message">
                No exams found.
            </div>
        `;

        return;

    }


    examGrid.innerHTML = "";


    exams.forEach(
        (exam) => {

            const card =
                createExamCard(
                    exam
                );


            examGrid.appendChild(
                card
            );

        }
    );

}


// ============================================================
// CREATE EXAM CARD
// ============================================================

function createExamCard(exam) {

    const card =
        document.createElement(
            "article"
        );


    card.className =
        "exam-card";


    // ========================================================
    // EXAM NAME
    // ========================================================

    const name =
        exam.name ||
        exam.title ||
        exam.examName ||
        formatExamName(
            exam.id
        );


    // ========================================================
    // DESCRIPTION
    // ========================================================

    const description =
        exam.description ||
        "Previous year question papers";


    // ========================================================
    // ICON
    // ========================================================

    const icon =
        exam.icon ||
        "📚";


    card.innerHTML = `

        <div class="exam-icon">
            ${escapeHTML(icon)}
        </div>

        <div class="exam-card-content">

            <h3>
                ${escapeHTML(name)}
            </h3>

            <p>
                ${escapeHTML(description)}
            </p>

        </div>

        <div class="exam-arrow">
            →
        </div>

    `;


    // ========================================================
    // OPEN EXAM
    // ========================================================

    card.addEventListener(
        "click",
        () => {

            window.location.href =
                `exam.html?id=${encodeURIComponent(exam.id)}`;

        }
    );


    return card;

}


// ============================================================
// SEARCH
// ============================================================

function searchExams() {

    const query =
        searchInput
            .value
            .trim()
            .toLowerCase();


    // Empty search

    if (!query) {

        displayExams(
            allExams
        );

        updateExamCount(
            allExams.length
        );

        return;

    }


    // ========================================================
    // FILTER
    // ========================================================

    const filteredExams =
        allExams.filter(
            (exam) => {

                const name =
                    String(
                        exam.name ||
                        exam.title ||
                        exam.examName ||
                        exam.id ||
                        ""
                    )
                    .toLowerCase();


                const description =
                    String(
                        exam.description ||
                        ""
                    )
                    .toLowerCase();


                return (
                    name.includes(query) ||
                    description.includes(query)
                );

            }
        );


    displayExams(
        filteredExams
    );


    updateExamCount(
        filteredExams.length
    );

}


// ============================================================
// SEARCH BUTTON
// ============================================================

if (searchButton) {

    searchButton.addEventListener(
        "click",
        searchExams
    );

}


// ============================================================
// SEARCH WHILE TYPING
// ============================================================

if (searchInput) {

    searchInput.addEventListener(
        "input",
        searchExams
    );


    searchInput.addEventListener(
        "keydown",
        (event) => {

            if (
                event.key === "Enter"
            ) {

                searchExams();

            }

        }
    );

}


// ============================================================
// UPDATE EXAM COUNT
// ============================================================

function updateExamCount(count) {

    if (!examCount) {
        return;
    }


    if (count === 1) {

        examCount.textContent =
            "1 exam";

    } else {

        examCount.textContent =
            `${count} exams`;

    }

}


// ============================================================
// FORMAT EXAM NAME
// ============================================================

function formatExamName(id) {

    return String(id)
        .replace(/[-_]+/g, " ")
        .replace(
            /\b\w/g,
            (character) =>
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
            (character) => {

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


// ============================================================
// START
// ============================================================

loadExams();