// ============================================================
// PYQs HUB — CONTACT PAGE
// FIREBASE + WHATSAPP
// ============================================================

import { db, auth } from "./firebase.js";

import {
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ============================================================
// ELEMENTS
// ============================================================

const contactForm =
    document.getElementById("contactForm");

const nameInput =
    document.getElementById("name");

const emailInput =
    document.getElementById("email");

const messageInput =
    document.getElementById("message");

const sendButton =
    document.getElementById("sendButton");

const contactStatus =
    document.getElementById("contactStatus");

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
// WHATSAPP NUMBER
// ============================================================
//
// IMPORTANT:
// Country code for India = 91
//
// Your number:
// 6299890944
//
// WhatsApp format:
// 916299890944
//
// ============================================================

const WHATSAPP_NUMBER =
    "916299890944";


// ============================================================
// SHOW STATUS
// ============================================================

function showStatus(message, type = "") {

    if (!contactStatus) {
        return;
    }

    contactStatus.textContent =
        message;

    contactStatus.className =
        `contact-status ${type}`;

}


// ============================================================
// LOAD LOGGED-IN USER
// ============================================================

function loadUserData() {

    const user =
        auth.currentUser;


    if (!user) {

        return;

    }


    // ========================================================
    // EMAIL
    // ========================================================

    if (
        user.email &&
        emailInput &&
        !emailInput.value.trim()
    ) {

        emailInput.value =
            user.email;

    }


    // ========================================================
    // NAME
    // ========================================================
    //
    // Firebase Auth normally doesn't store a custom profile
    // name unless displayName exists.
    //
    // If displayName exists, use it.
    //
    // ========================================================

    if (
        user.displayName &&
        nameInput &&
        !nameInput.value.trim()
    ) {

        nameInput.value =
            user.displayName;

    }

}


// ============================================================
// AUTH STATE
// ============================================================

auth.onAuthStateChanged(
    (user) => {

        if (user) {

            loadUserData();

        }

    }
);


// ============================================================
// SEND CONTACT MESSAGE
// ============================================================

if (contactForm) {

    contactForm.addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            // ==================================================
            // GET VALUES
            // ==================================================

            const name =
                nameInput.value.trim();

            const email =
                emailInput.value.trim();

            const message =
                messageInput.value.trim();


            // ==================================================
            // VALIDATION
            // ==================================================

            if (!name) {

                showStatus(
                    "Please enter your name.",
                    "error"
                );

                nameInput.focus();

                return;

            }


            if (!email) {

                showStatus(
                    "Please enter your email.",
                    "error"
                );

                emailInput.focus();

                return;

            }


            if (!message) {

                showStatus(
                    "Please enter your message.",
                    "error"
                );

                messageInput.focus();

                return;

            }


            // ==================================================
            // PREVENT DOUBLE CLICK
            // ==================================================

            sendButton.disabled =
                true;

            sendButton.textContent =
                "Sending...";


            try {

                // =================================================
                // CURRENT USER
                // =================================================

                const user =
                    auth.currentUser;


                // =================================================
                // SAVE TO FIRESTORE
                // =================================================

                await addDoc(
                    collection(
                        db,
                        "contacts"
                    ),
                    {

                        userId:
                            user
                                ? user.uid
                                : "",

                        name:
                            name,

                        email:
                            email,

                        message:
                            message,

                        status:
                            "new",

                        createdAt:
                            serverTimestamp()

                    }
                );


                // =================================================
                // WHATSAPP MESSAGE
                // =================================================

                const whatsappMessage =
`Hello PYQs Hub,

Name: ${name}

Email: ${email}

Message:
${message}`;


                const whatsappURL =
                    `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(
                        whatsappMessage
                    )}`;


                // =================================================
                // OPEN WHATSAPP
                // =================================================

                window.location.href =
                    whatsappURL;


                // =================================================
                // RESET
                // =================================================

                contactForm.reset();


                showStatus(
                    "Opening WhatsApp...",
                    "success"
                );


            } catch (error) {

                console.error(
                    "Contact form error:",
                    error
                );


                showStatus(
                    "Unable to send your message. Please try again.",
                    "error"
                );


            } finally {

                sendButton.disabled =
                    false;

                sendButton.textContent =
                    "Send on WhatsApp";

            }

        }
    );

}


// ============================================================
// INITIAL USER DATA
// ============================================================
//
// Sometimes auth.currentUser is already available when the
// page loads. This handles that case too.
// ============================================================

if (auth.currentUser) {

    loadUserData();

}