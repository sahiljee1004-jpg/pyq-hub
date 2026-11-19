import { auth, db } from "./firebase.js";
import {
    addDoc,
    collection,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const dialog = document.getElementById("counsellingDialog");
const form = document.getElementById("counsellingForm");
const nameInput = document.getElementById("counsellingName");
const emailInput = document.getElementById("counsellingEmail");
const phoneInput = document.getElementById("counsellingPhone");
const statusMessage = document.getElementById("counsellingStatus");
const submitButton = document.getElementById("submitCounselling");
let isSubmitting = false;

document.getElementById("admissionYear").textContent = new Date().getFullYear();

function setStatus(message, state = "") {
    statusMessage.textContent = message;
    statusMessage.className = `admission-form-status${state ? ` ${state}` : ""}`;
}

function openCounsellingForm() {
    setStatus("");
    if (!dialog.open) dialog.showModal();
    nameInput.focus();
}

document.querySelectorAll("[data-open-counselling]").forEach((button) => {
    button.addEventListener("click", openCounsellingForm);
});

if (window.location.hash === "#counselling") {
    document.getElementById("counselling").scrollIntoView({ block: "start" });
    openCounsellingForm();
}

document.getElementById("closeCounsellingDialog").addEventListener("click", () => {
    dialog.close();
});

dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSubmitting) return;

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    const phoneDigits = phone.replace(/\D/g, "");
    const validPhoneCharacters = /^\+?[0-9][0-9\s().-]*$/.test(phone);

    if (!name) {
        setStatus("Please enter your full name.", "error");
        nameInput.focus();
        return;
    }

    if (!email || !emailInput.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setStatus("Please enter a valid email address.", "error");
        emailInput.focus();
        return;
    }

    if (!validPhoneCharacters || phoneDigits.length < 7 || phoneDigits.length > 15) {
        setStatus("Please enter a valid phone number with 7 to 15 digits.", "error");
        phoneInput.focus();
        return;
    }

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    setStatus("Submitting your enquiry…", "pending");

    try {
        await addDoc(collection(db, "contacts"), {
            userId: auth.currentUser?.uid || "",
            name,
            email,
            message: `Admission counselling enquiry. Phone number: ${phone}`,
            status: "new",
            createdAt: serverTimestamp()
        });

        form.reset();
        setStatus("Thank you. Your enquiry has been received. Redirecting...", "success");
        window.location.assign("https://collegeaspire.com/");
    } catch (error) {
        console.error("[Admission] Could not submit counselling enquiry:", error);
        setStatus("We couldn't submit your enquiry. Please check your connection and try again.", "error");
    } finally {
        isSubmitting = false;
        submitButton.disabled = false;
        submitButton.innerHTML = `Submit Enquiry
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>`;
    }
});
