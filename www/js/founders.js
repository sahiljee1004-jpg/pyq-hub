import { getApiUrl } from "./api-config.js";

const founderSection = document.getElementById("founders-section");
const founderGrid = document.getElementById("foundersGrid");
const founderStatus = document.getElementById("foundersStatus");

function optimizedCloudinaryUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") {
            return null;
        }

        const uploadMarker = "/image/upload/";
        if (!url.pathname.includes(uploadMarker)) {
            return null;
        }

        url.pathname = url.pathname.replace(
            uploadMarker,
            `${uploadMarker}f_auto,q_auto,w_480,h_480,c_fill,g_face/`
        );
        return url.href;
    } catch {
        return null;
    }
}

function showStatus(message, isError = false) {
    founderStatus.textContent = message;
    founderStatus.hidden = !message;
    founderStatus.dataset.error = String(isError);
}

function renderProfile(card, profile) {
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const imageUrl = optimizedCloudinaryUrl(profile.imageUrl);
    if (!name || !imageUrl) {
        return false;
    }

    const image = card.querySelector(".founder-photo-wrap img");
    const placeholder = card.querySelector(".founder-avatar-placeholder");
    const bio = card.querySelector(".founder-bio");

    card.querySelector(".founder-name").textContent = name;
    card.querySelector(".founder-designation").textContent = "Co-Founder";
    bio.textContent = typeof profile.bio === "string" ? profile.bio.trim() : "";
    bio.hidden = !bio.textContent;

    image.alt = `${name} profile photograph`;
    card.hidden = false;
    image.hidden = false;
    placeholder.hidden = true;
    image.addEventListener("load", () => {
        image.hidden = false;
        placeholder.hidden = true;
    }, { once: true });
    image.addEventListener("error", () => {
        image.hidden = true;
        placeholder.hidden = false;
    }, { once: true });
    image.src = imageUrl;
    return true;
}

async function loadFounderProfiles() {
    if (!founderSection || !founderGrid || !founderStatus) {
        return;
    }

    const cards = [...founderGrid.querySelectorAll(".founder-card[data-founder-id]")];
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(getApiUrl("/api/founders"), { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data.profiles)) {
            throw new Error("The founder profile response was invalid.");
        }

        const profiles = new Map(data.profiles.map(profile => [profile.id, profile]));
        let visibleCount = 0;
        for (const card of cards) {
            const profile = profiles.get(card.dataset.founderId);
            if (profile && renderProfile(card, profile)) {
                visibleCount += 1;
            } else {
                card.hidden = true;
            }
        }

        if (visibleCount === 0) {
            showStatus("Founder profiles are being prepared. Please check back soon.");
        } else if (visibleCount < cards.length) {
            showStatus("Additional founder profiles are being prepared.");
        } else {
            showStatus("");
        }
    } catch (error) {
        if (error.name !== "AbortError") {
            console.error("[Founders] Unable to load founder profiles:", error);
        }
        for (const card of cards) {
            card.hidden = true;
        }
        showStatus("Founder profiles could not be loaded. Please try again later.", true);
    } finally {
        window.clearTimeout(timeoutId);
        founderSection.setAttribute("aria-busy", "false");
    }
}

loadFounderProfiles();
