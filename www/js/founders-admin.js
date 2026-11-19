import { auth } from "./firebase.js";
import { getApiUrl } from "./api-config.js";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Map([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".webp", "image/webp"]
]);
const existingProfiles = new Map();
const previewObjectUrls = new Map();
let profilesLoaded = false;
let profilesLoading = false;

function setFormStatus(form, message, isError = false) {
    const status = form.querySelector(".founder-admin-status");
    status.textContent = message;
    status.style.color = isError ? "#b91c1c" : "#15803d";
}

function validateImage(file) {
    if (!file) {
        return "Choose a profile photograph.";
    }

    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (ACCEPTED_IMAGE_TYPES.get(extension) !== file.type) {
        return "Choose a matching JPG, JPEG, PNG, or WebP image.";
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
        return "The image must be larger than 0 bytes and no more than 5 MB.";
    }
    return "";
}

function setPreview(form, url) {
    const image = form.querySelector(".founder-admin-preview");
    const oldObjectUrl = previewObjectUrls.get(form);
    if (oldObjectUrl && oldObjectUrl !== url) {
        URL.revokeObjectURL(oldObjectUrl);
        previewObjectUrls.delete(form);
    }

    image.hidden = !url;
    if (url) {
        if (url.startsWith("blob:")) {
            previewObjectUrls.set(form, url);
        }
        image.src = url;
    } else {
        image.removeAttribute("src");
    }
}

function readAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            const dataUrl = typeof reader.result === "string" ? reader.result : "";
            const separator = dataUrl.indexOf(",");
            if (separator < 0) {
                reject(new Error("The selected image could not be read."));
                return;
            }
            resolve(dataUrl.slice(separator + 1));
        }, { once: true });
        reader.addEventListener("error", () => {
            reject(new Error("The selected image could not be read."));
        }, { once: true });
        reader.readAsDataURL(file);
    });
}

async function loadExistingProfiles() {
    const status = document.getElementById("founderAdminLoadStatus");
    if (profilesLoaded || profilesLoading) {
        return;
    }
    profilesLoading = true;
    try {
        if (!auth.currentUser) {
            throw new Error("Sign in as an administrator to load founder profiles.");
        }
        const token = await auth.currentUser.getIdToken();
        const response = await fetch(getApiUrl("/api/founders/admin"), {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.profiles)) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        for (const profile of data.profiles) {
            existingProfiles.set(profile.id, profile);
        }

        for (const form of document.querySelectorAll(".founder-admin-form")) {
            const profile = existingProfiles.get(form.dataset.founderId);
            if (!profile) {
                continue;
            }
            form.elements.name.value = profile.name || "";
            form.elements.bio.value = profile.bio || "";
            setPreview(form, profile.imageUrl || "");
        }
        profilesLoaded = true;
        for (const form of document.querySelectorAll(".founder-admin-form")) {
            form.querySelector('button[type="submit"]').disabled = false;
        }
        status.textContent = data.profiles.length
            ? "Existing founder profiles loaded. Saving updates only the selected profile."
            : "No founder profiles are saved yet. Add a photograph to publish each profile.";
        status.style.color = "#64748b";
    } catch (error) {
        console.error("[Founders Admin] Unable to load existing profiles:", error);
        status.textContent = error.message || "Existing founder profiles could not be loaded. Please try again.";
        status.style.color = "#b91c1c";
    } finally {
        profilesLoading = false;
    }
}

for (const form of document.querySelectorAll(".founder-admin-form")) {
    const fileInput = form.elements.image;
    form.querySelector('button[type="submit"]').disabled = true;

    fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (!file) {
            setPreview(form, existingProfiles.get(form.dataset.founderId)?.imageUrl || "");
            return;
        }

        const validationError = validateImage(file);
        if (validationError) {
            fileInput.value = "";
            setPreview(form, existingProfiles.get(form.dataset.founderId)?.imageUrl || "");
            setFormStatus(form, validationError, true);
            return;
        }

        const objectUrl = URL.createObjectURL(file);
        previewObjectUrls.set(form, objectUrl);
        setPreview(form, objectUrl);
        setFormStatus(form, `${file.name} is ready to upload.`);
    });

    form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        const file = fileInput.files[0];
        const founderId = form.dataset.founderId;
        const name = form.elements.name.value.trim();
        const bio = form.elements.bio.value.trim();

        if (!profilesLoaded) {
            setFormStatus(form, "Load existing profiles before saving to protect existing information.", true);
            return;
        }
        if (!name || name.length > 100) {
            setFormStatus(form, "Enter a founder name of 1 to 100 characters.", true);
            return;
        }
        if (bio.length > 600) {
            setFormStatus(form, "The biography cannot exceed 600 characters.", true);
            return;
        }
        if (file) {
            const validationError = validateImage(file);
            if (validationError) {
                setFormStatus(form, validationError, true);
                return;
            }
        } else if (!existingProfiles.get(founderId)?.imageUrl) {
            setFormStatus(form, "Choose a profile photograph before publishing this profile.", true);
            return;
        }
        if (!auth.currentUser) {
            setFormStatus(form, "Your administrator session has expired. Sign in again to continue.", true);
            return;
        }

        button.disabled = true;
        const originalButtonText = button.textContent;
        button.textContent = "Saving...";
        setFormStatus(form, file ? "Uploading image and saving profile..." : "Saving profile...");

        try {
            const payload = {
                name,
                bio,
                image: file ? {
                    name: file.name,
                    type: file.type,
                    base64: await readAsBase64(file)
                } : null
            };
            const token = await auth.currentUser.getIdToken();
            const response = await fetch(getApiUrl(`/api/founders/${founderId}`), {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok || !data.success || !data.profile) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            existingProfiles.set(founderId, data.profile);
            setPreview(form, data.profile.imageUrl);
            fileInput.value = "";
            setFormStatus(form, "Founder profile saved successfully.");
        } catch (error) {
            console.error(`[Founders Admin] Save failed for ${founderId}:`, error);
            setFormStatus(form, error.message || "The founder profile could not be saved.", true);
        } finally {
            button.disabled = false;
            button.textContent = originalButtonText;
        }
    });
}

document.querySelector('.admin-tab-btn[data-tab="founders"]')
    ?.addEventListener("click", loadExistingProfiles);
