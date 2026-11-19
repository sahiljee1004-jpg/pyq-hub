import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// Helper to preserve CRLF
function writeWithSameEol(filePath, newContent, originalContent) {
    const isCRLF = originalContent.includes('\r\n');
    const normalized = newContent.replace(/\r\n/g, '\n');
    const finalContent = isCRLF ? normalized.replace(/\n/g, '\r\n') : normalized;
    fs.writeFileSync(filePath, finalContent, 'utf8');
}

// 1. LIVE-UPDATES.JS
{
    const file = path.join(root, 'www/js/live-updates.js');
    let content = fs.readFileSync(file, 'utf8');
    let norm = content.replace(/\r\n/g, '\n');

    if (!norm.includes('import { SkeletonManager }')) {
        norm = norm.replace(
            'import { safeURL } from "./pdf-viewer-core.js";',
            'import { safeURL } from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );
    }

    const oldLoading = `    setSearchButtonLoading(true);
    renderLoadingState(\`Searching latest updates for "\${query}"...\`);

    currentQuery = query;`;

    const newLoading = `    setSearchButtonLoading(true);
    let skeletonUpdates = null;
    if (updatesFeed) {
        updatesFeed.innerHTML = "";
        skeletonUpdates = SkeletonManager.mount(
            updatesFeed,
            () => SkeletonManager.templates.liveUpdates(4),
            { delay: 200, ariaLabel: \`Searching latest updates for "\${query}"...\` }
        );
    }

    currentQuery = query;`;

    norm = norm.replace(oldLoading, newLoading);

    const oldSuccess = `        if (data.success && Array.isArray(data.updates) && data.updates.length > 0) {
            showSearchContext(query, data.updates.length);
            renderUpdatesFeed(data.updates);
        } else {
            if (searchContextBar) searchContextBar.style.display = "none";
            renderEmptyState(\`No recent updates found for "\${query}". Try searching with a broader exam name.\`);
        }`;

    const newSuccess = `        skeletonUpdates?.dismiss(() => {
            if (data.success && Array.isArray(data.updates) && data.updates.length > 0) {
                showSearchContext(query, data.updates.length);
                renderUpdatesFeed(data.updates);
            } else {
                if (searchContextBar) searchContextBar.style.display = "none";
                renderEmptyState(\`No recent updates found for "\${query}". Try searching with a broader exam name.\`);
            }
        });`;

    norm = norm.replace(oldSuccess, newSuccess);

    norm = norm.replace(
        'console.error("[Live Updates Search Exception]:", err);',
        'skeletonUpdates?.cancel();\n        console.error("[Live Updates Search Exception]:", err);'
    );

    writeWithSameEol(file, norm, content);
    console.log('Updated www/js/live-updates.js');
}

// 2. AI-CHAT.JS
{
    const file = path.join(root, 'www/js/ai-chat.js');
    let content = fs.readFileSync(file, 'utf8');
    let norm = content.replace(/\r\n/g, '\n');

    if (!norm.includes('import { SkeletonManager }')) {
        norm = norm.replace(
            'import { openChatGPT } from "./chatgpt-helper.js";',
            'import { openChatGPT } from "./chatgpt-helper.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );
    }

    const oldAuth = `function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser) {
            await loadSavedChatHistory(currentUser.uid);
        } else {
            renderWelcomeMessage();
        }
    });
}`;

    const newAuth = `function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser) {
            const chatSkeleton = chatContainer ? SkeletonManager.mount(
                chatContainer,
                () => SkeletonManager.templates.aiChat(3),
                { delay: 200, ariaLabel: "Loading chat conversation..." }
            ) : null;
            await loadSavedChatHistory(currentUser.uid);
            chatSkeleton?.dismiss();
        } else {
            renderWelcomeMessage();
        }
    });
}`;

    norm = norm.replace(oldAuth, newAuth);

    writeWithSameEol(file, norm, content);
    console.log('Updated www/js/ai-chat.js');
}

// 3. PROFILE.JS
{
    const file = path.join(root, 'www/js/profile.js');
    let content = fs.readFileSync(file, 'utf8');
    let norm = content.replace(/\r\n/g, '\n');

    if (!norm.includes('import { SkeletonManager }')) {
        norm = norm.replace(
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );
    }

    const oldTarget = `        // ====================================================
        // LOAD FIRESTORE PROFILE
        // ====================================================

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );`;

    const newTarget = `        // ====================================================
        // LOAD FIRESTORE PROFILE
        // ====================================================

        const profileCardEl = document.querySelector(".profile-card, .profile-page") || profileNameBox?.parentElement;
        const profileSkeleton = profileCardEl ? SkeletonManager.mount(
            profileCardEl,
            () => SkeletonManager.templates.profile(),
            { delay: 200, ariaLabel: "Loading student profile..." }
        ) : null;

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );`;

    norm = norm.replace(oldTarget, newTarget);

    const oldExists = `            if (snapshot.exists()) {

                const data =
                    snapshot.data();


                displayProfile(
                    user,
                    data
                );

            }`;

    const newExists = `            profileSkeleton?.dismiss(() => {
                if (snapshot.exists()) {
                    const data = snapshot.data();
                    displayProfile(user, data);
                }
            });`;

    norm = norm.replace(oldExists, newExists);

    norm = norm.replace(
        'console.error(\n                "Profile loading error:",\n                error\n            );',
        'profileSkeleton?.cancel();\n            console.error(\n                "Profile loading error:",\n                error\n            );'
    );

    writeWithSameEol(file, norm, content);
    console.log('Updated www/js/profile.js');
}

// 4. EDIT-PROFILE.JS
{
    const file = path.join(root, 'www/js/edit-profile.js');
    let content = fs.readFileSync(file, 'utf8');
    let norm = content.replace(/\r\n/g, '\n');

    if (!norm.includes('import { SkeletonManager }')) {
        norm = norm.replace(
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );
    }

    const oldTarget = `        let name =
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
                );`;

    const newTarget = `        let name =
            user.displayName || "";

        const formCardEl = document.getElementById("editProfileForm") || document.querySelector(".auth-card");
        const editSkeleton = formCardEl ? SkeletonManager.mount(
            formCardEl,
            () => SkeletonManager.templates.editProfile(),
            { delay: 200, ariaLabel: "Loading account settings..." }
        ) : null;

        // ----------------------------------------------------
        // FIRESTORE PROFILE
        // ----------------------------------------------------

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );`;

    norm = norm.replace(oldTarget, newTarget);

    const oldDisplay = `        nameInput.value =
            name;


        updateAvatar(
            name,
            user.email
        );`;

    const newDisplay = `        editSkeleton?.dismiss(() => {
            nameInput.value = name;
            updateAvatar(name, user.email);
        });`;

    norm = norm.replace(oldDisplay, newDisplay);

    norm = norm.replace(
        'console.error(\n                "Profile loading error:",\n                error\n            );',
        'editSkeleton?.cancel();\n            console.error(\n                "Profile loading error:",\n                error\n            );'
    );

    writeWithSameEol(file, norm, content);
    console.log('Updated www/js/edit-profile.js');
}
