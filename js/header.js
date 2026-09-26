// ============================================================
// PYQs HUB — HEADER AUTH
// LOGIN / SIGN UP  <->  PROFILE CIRCLE
// ============================================================

import { auth } from "./firebase.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";


// ============================================================
// WAIT FOR HEADER
// ============================================================

function setupHeader() {

    const authButton =
        document.getElementById("authButton");

    if (!authButton) {
        console.log("authButton not found");
        return;
    }


    // ========================================================
    // FIREBASE AUTH STATE
    // ========================================================

    onAuthStateChanged(
        auth,
        (user) => {

            // ================================================
            // LOGGED IN
            // ================================================

            if (user) {

                let letter = "U";

                if (user.displayName) {

                    letter =
                        user.displayName
                            .trim()
                            .charAt(0)
                            .toUpperCase();

                } else if (user.email) {

                    letter =
                        user.email
                            .trim()
                            .charAt(0)
                            .toUpperCase();

                }


                // --------------------------------------------
                // PROFILE PHOTO
                // --------------------------------------------

                if (user.photoURL) {

                    authButton.innerHTML = `
                        <img
                            src="${user.photoURL}"
                            alt="Profile"
                            class="profile-circle"
                        >
                    `;

                }

                // --------------------------------------------
                // FIRST LETTER
                // --------------------------------------------

                else {

                    authButton.innerHTML = `
                        <span class="profile-circle">
                            ${letter}
                        </span>
                    `;

                }


                authButton.href =
                    "profile.html";

                authButton.classList.add(
                    "profile-active"
                );


                console.log(
                    "User logged in:",
                    user.email
                );

            }


            // =================================================
            // LOGGED OUT
            // =================================================

            else {

                authButton.innerHTML =
                    "Login / Sign Up";

                authButton.href =
                    "login.html";

                authButton.classList.remove(
                    "profile-active"
                );


                console.log(
                    "User logged out"
                );

            }

        }
    );

}


// ============================================================
// START
// ============================================================

if (
    document.readyState === "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        setupHeader
    );

} else {

    setupHeader();

}