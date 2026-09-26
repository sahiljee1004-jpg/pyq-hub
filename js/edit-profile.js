// ============================================================
// PYQs HUB — EDIT PROFILE
// Firebase Authentication + Firestore
// ============================================================

import { auth, db } from "./firebase.js";

import {
    onAuthStateChanged,
    updateProfile
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    doc,
    getDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ============================================================
// ELEMENTS
// ============================================================

const form =
    document.getElementById("editProfileForm");

const nameInput =
    document.getElementById("name");

const emailInput =
    document.getElementById("email");

const saveButton =
    document.getElementById("saveButton");

const message =
    document.getElementById("message");

const avatar =
    document.getElementById("profileAvatar");

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
// INITIALS
// ============================================================

function getInitials(name, email) {

    if (name && name.trim()) {

        const words =
            name.trim().split(/\s+/);

        if (words.length >= 2) {

            return (
                words[0][0] +
                words[words.length - 1][0]
            ).toUpperCase();

        }

        return words[0]
            .substring(0, 2)
            .toUpperCase();

    }

    if (email) {

        return email
            .substring(0, 2)
            .toUpperCase();

    }

    return "U";
}


// ============================================================
// SHOW MESSAGE
// ============================================================

function showMessage(text, type = "") {

    if (!message) return;

    message.textContent = text;

    message.className =
        `profile-message ${type}`;

}


// ============================================================
// LOAD USER
// ============================================================

onAuthStateChanged(
    auth,
    async (user) => {

        // ----------------------------------------------------
        // NOT LOGGED IN
        // ----------------------------------------------------

        if (!user) {

            window.location.replace(
                "login.html"
            );

            return;

        }


        // ----------------------------------------------------
        // AUTH DATA
        // ----------------------------------------------------

        emailInput.value =
            user.email || "";


        let name =
            user.displayName || "";


        // ----------------------------------------------------
        // FIRESTORE PROFILE
        // ----------------------------------------------------

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(userRef);


            if (snapshot.exists()) {

                const data =
                    snapshot.data();

                if (data.name) {

                    name =
                        data.name;

                }

            }

        } catch (error) {

            console.error(
                "Profile loading error:",
                error
            );

        }


        // ----------------------------------------------------
        // DISPLAY
        // ----------------------------------------------------

        nameInput.value =
            name;


        updateAvatar(
            name,
            user.email
        );

    }
);


// ============================================================
// UPDATE AVATAR
// ============================================================

function updateAvatar(
    name,
    email
) {

    if (!avatar) return;

    avatar.textContent =
        getInitials(
            name,
            email
        );

}


// ============================================================
// NAME TYPING → AVATAR UPDATE
// ============================================================

if (nameInput) {

    nameInput.addEventListener(
        "input",
        () => {

            updateAvatar(
                nameInput.value,
                emailInput.value
            );

        }
    );

}


// ============================================================
// SAVE PROFILE
// ============================================================

if (form) {

    form.addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            const user =
                auth.currentUser;


            if (!user) {

                window.location.replace(
                    "login.html"
                );

                return;

            }


            const name =
                nameInput.value.trim();


            if (!name) {

                showMessage(
                    "Please enter your name.",
                    "error"
                );

                return;

            }


            try {

                saveButton.disabled =
                    true;

                saveButton.textContent =
                    "Saving...";

                showMessage("");


                // ------------------------------------------------
                // UPDATE FIREBASE AUTH PROFILE
                // ------------------------------------------------

                await updateProfile(
                    user,
                    {
                        displayName: name
                    }
                );


                // ------------------------------------------------
                // UPDATE FIRESTORE
                // ------------------------------------------------

                const userRef =
                    doc(
                        db,
                        "users",
                        user.uid
                    );


                await setDoc(
                    userRef,
                    {
                        name: name,
                        email: user.email || "",
                        updatedAt: new Date()
                    },
                    {
                        merge: true
                    }
                );


                // ------------------------------------------------
                // SUCCESS
                // ------------------------------------------------

                showMessage(
                    "Profile updated successfully!",
                    "success"
                );


                setTimeout(
                    () => {

                        window.location.replace(
                            "profile.html"
                        );

                    },
                    700
                );


            } catch (error) {

                console.error(
                    "Profile update error:",
                    error
                );


                showMessage(
                    "Unable to update profile. Please try again.",
                    "error"
                );


                saveButton.disabled =
                    false;

                saveButton.textContent =
                    "Save Changes";

            }

        }
    );

}