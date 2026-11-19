// ============================================================
// VIDYARTHIVERSE — NATIVE CAPACITOR INTEGRATION & BACK BUTTON
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        const App = window.Capacitor.Plugins.App;

        App.addListener("backButton", () => {
            // 1. Close PDF Viewer Modal if active
            const paperViewer = document.getElementById("paperViewer");
            if (paperViewer && !paperViewer.classList.contains("hidden")) {
                const closeBtn = document.getElementById("closeViewer");
                if (closeBtn) {
                    closeBtn.click();
                    return;
                }
            }

            // 2. Close Auth Modal if active
            const authModal = document.getElementById("authModal");
            if (authModal && authModal.classList.contains("show")) {
                const closeAuth = document.getElementById("closeAuthModal");
                if (closeAuth) {
                    closeAuth.click();
                    return;
                }
            }

            // 3. Navigate back or minimize app on home screen
            const isHomePage =
                window.location.pathname.endsWith("index.html") ||
                window.location.pathname === "/" ||
                window.location.pathname.endsWith("/");

            if (!isHomePage) {
                window.history.back();
            } else {
                App.minimizeApp();
            }
        });
    }
});
