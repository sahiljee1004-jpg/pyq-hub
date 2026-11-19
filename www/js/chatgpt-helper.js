// ============================================================
// VIDYARTHIVERSE — CHATGPT REDIRECT HELPER
// Centralized ChatGPT deep link / web browser launcher
// Used by Home-page shortcut & AI Assistant locked page
// ============================================================

export function openChatGPT() {
    const isCapacitorNative =
        window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === "function" &&
        window.Capacitor.isNativePlatform();

    if (isCapacitorNative) {
        let appOpened = false;
        const startTime = Date.now();

        const handleBlur = () => {
            appOpened = true;
            cleanup();
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                appOpened = true;
                cleanup();
            }
        };

        const cleanup = () => {
            window.removeEventListener("blur", handleBlur);
            window.removeEventListener("pagehide", handleBlur);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };

        window.addEventListener("blur", handleBlur);
        window.addEventListener("pagehide", handleBlur);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        // 1. Attempt deep-link launch of native ChatGPT app
        window.location.href = "chatgpt://";

        // 2. Fallback to external default browser after timeout if app was not opened
        setTimeout(() => {
            cleanup();
            const elapsed = Date.now() - startTime;
            if (!appOpened && elapsed < 2500) {
                if (
                    window.Capacitor &&
                    window.Capacitor.Plugins &&
                    window.Capacitor.Plugins.Browser
                ) {
                    window.Capacitor.Plugins.Browser.open({
                        url: "https://chatgpt.com/"
                    });
                } else {
                    window.open("https://chatgpt.com/", "_system") ||
                    window.open("https://chatgpt.com/", "_blank");
                }
            }
        }, 1200);
    } else {
        // Desktop / standard web browser
        window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer");
    }
}

if (typeof window !== "undefined") {
    window.openChatGPT = openChatGPT;
}
