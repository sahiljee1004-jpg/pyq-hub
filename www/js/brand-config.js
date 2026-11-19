// ============================================================
// VIDYARTHIASTRA — BRAND CONFIGURATION
// Centralized brand configuration for the web and native client
// ============================================================

export const BRAND_CONFIG = {
    APP_NAME: "VidyarthiAstra",
    APP_SHORT_NAME: "VidyarthiAstra",
    APP_TAGLINE: "Previous Year Question Papers & Study Resources",
    APP_DESCRIPTION: "Access previous year question papers, study resources, AI assistance, and live exam updates on VidyarthiAstra.",
    LOGO_PATH: "assets/branding/vidyarthiastra-logo.png",
    LOGO_TRANSPARENT_PATH: "assets/branding/vidyarthiastra-logo.png",
    ICON_PATH: "assets/branding/vidyarthiverse-icon.png",
    ICON_TRANSPARENT_PATH: "assets/branding/vidyarthiverse-icon-transparent.png",
    AI_ASSISTANT_NAME: "VidyarthiAstra AI Assistant",
    LIVE_UPDATES_NAME: "VidyarthiAstra Live Updates",
    PAPERS_NAME: "VidyarthiAstra Papers",
    STUDY_RESOURCES_NAME: "VidyarthiAstra Study Resources",
    CHATBOT_ICON_PATH: "assets/branding/chatbot-gpt-icon.png",

    // ============================================================
    // FEATURE FLAGS
    // ============================================================
    // AI_ASSISTANT_ENABLED: Controls UI availability of the VidyarthiAstra AI Assistant.
    // - false: Shows dedicated locked "Coming Soon" screen with "Ask GPT for now" button.
    //          Prevents any AI backend requests from being made by the UI.
    // - true:  Enables full VidyarthiAstra AI Assistant interface and features.
    // ============================================================
    AI_ASSISTANT_ENABLED: false
};

export const AI_ASSISTANT_ENABLED = BRAND_CONFIG.AI_ASSISTANT_ENABLED;

if (typeof window !== "undefined") {
    window.BRAND_CONFIG = BRAND_CONFIG;
    window.AI_ASSISTANT_ENABLED = AI_ASSISTANT_ENABLED;
}

