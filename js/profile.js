// ============================================================
// PYQs HUB — PROFILE PAGE
// Firebase Authentication + Firestore
// ============================================================

import { auth, db } from "./firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ============================================================
// ELEMENTS
// ============================================================

const profileAvatar =
    document.getElementById("profileAvatar");

const profileName =
    document.getElementById("profileName");

const profileEmail =
    document.getElementById("profileEmail");

const profileNameBox =
    document.getElementById("profileNameBox");

const profileEmailBox =
    document.getElementById("profileEmailBox");

const logoutButton =
    document.getElementById("logoutButton");


// ============================================================
// GET USER INITIALS
// ============================================================

function getInitials(name, email) {

    if (name && name.trim()) {

        const words =
            name.trim().split(/\s+/);


        // Example:
        // SAHIL RAJPUT → SR

        if (words.length >= 2) {

            return (
                words[0].charAt(0) +
                words[words.length - 1].charAt(0)
            ).toUpperCase();

        }


        // Example:
        // SAHIL → SA

        return words[0]
            .substring(0, 2)
            .toUpperCase();

    }


    // If name doesn't exist,
    // use first letter of email

    if (email) {

        return email
            .charAt(0)
            .toUpperCase();

    }


    return "U";
}


// ============================================================
// DISPLAY PROFILE
// ============================================================

function displayProfile(user, data = {}) {

    // --------------------------------------------------------
    // NAME
    // --------------------------------------------------------

    const name =
        data.name ||
        user.displayName ||
        "PYQs Hub User";


    // --------------------------------------------------------
    // EMAIL
    // --------------------------------------------------------

    const email =
        data.email ||
        user.email ||
        "No email";


    // --------------------------------------------------------
    // PROFILE PHOTO
    // --------------------------------------------------------

    const photoURL =
        data.photoURL ||
        user.photoURL ||
        "";


    // ========================================================
    // TOP NAME
    // ========================================================

    if (profileName) {

        profileName.textContent =
            name;

    }


    // ========================================================
    // TOP EMAIL
    // ========================================================

    if (profileEmail) {

        profileEmail.textContent =
            email;

    }


    // ========================================================
    // NAME BOX
    // ========================================================

    if (profileNameBox) {

        profileNameBox.textContent =
            name;

    }


    // ========================================================
    // EMAIL BOX
    // ========================================================

    if (profileEmailBox) {

        profileEmailBox.textContent =
            email;

    }


    // ========================================================
    // PROFILE AVATAR
    // ========================================================

    if (profileAvatar) {

        // If user has profile photo

        if (photoURL) {

            profileAvatar.innerHTML = `
                <img
                    src="${photoURL}"
                    alt="Profile"
                >
            `;

        }

        // Otherwise show initials

        else {

            profileAvatar.textContent =
                getInitials(
                    name,
                    email
                );

        }

    }

}


// ============================================================
// AUTHENTICATION STATE
// ============================================================

onAuthStateChanged(
    auth,
    async (user) => {


        // ====================================================
        // USER NOT LOGGED IN
        // ====================================================

        if (!user) {

            window.location.replace(
                "login.html"
            );

            return;

        }


        // ====================================================
        // SHOW FIREBASE AUTH DATA IMMEDIATELY
        // ====================================================
        //
        // This prevents the page from getting stuck on
        // "Loading..." while Firestore is loading.
        //

        displayProfile(
            user,
            {
                name:
                    user.displayName || "",

                email:
                    user.email || "",

                photoURL:
                    user.photoURL || ""
            }
        );


        // ====================================================
        // LOAD FIRESTORE PROFILE
        // ====================================================

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(
                    userRef
                );


            // =================================================
            // PROFILE EXISTS
            // =================================================

            if (snapshot.exists()) {

                const data =
                    snapshot.data();


                displayProfile(
                    user,
                    data
                );

            }

        }

        catch (error) {

            console.error(
                "Firestore profile error:",
                error
            );


            // Don't keep page stuck on Loading.
            // Firebase Auth information is already visible.

        }

    }
);


// ============================================================
// LOGOUT
// ============================================================

if (logoutButton) {

    logoutButton.addEventListener(
        "click",
        async () => {

            try {

                // Disable button

                logoutButton.disabled =
                    true;


                logoutButton.textContent =
                    "Logging out...";


                // Firebase logout

                await signOut(auth);


                // Go to Home

                window.location.replace(
                    "index.html"
                );

            }

            catch (error) {

                console.error(
                    "Logout error:",
                    error
                );


                // Restore button

                logoutButton.disabled =
                    false;


                logoutButton.textContent =
                    "Logout";

            }

        }
    );

}