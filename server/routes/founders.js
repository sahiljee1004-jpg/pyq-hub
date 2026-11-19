import express from "express";
import { AdminAuthService } from "../services/admin/adminAuthService.js";
import { StorageVaultService } from "../services/admin/storageVaultService.js";
import { UniversalFirestoreService } from "../services/admin/universalFirestoreService.js";

const router = express.Router();
const FOUNDER_IDS = ["founder-1", "founder-2", "founder-3"];
const MAX_BASE64_IMAGE_LENGTH = Math.ceil((5 * 1024 * 1024) / 3) * 4;

function isCloudinaryImageUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            && url.hostname === "res.cloudinary.com"
            && url.pathname.includes("/image/upload/");
    } catch {
        return false;
    }
}

function toPublicProfile(document) {
    if (!document || !FOUNDER_IDS.includes(document.id)) {
        return null;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    if (!name || !isCloudinaryImageUrl(document.imageUrl)) {
        return null;
    }

    return {
        id: document.id,
        name,
        designation: "Co-Founder",
        bio: typeof document.bio === "string" ? document.bio : "",
        imageUrl: document.imageUrl,
        order: FOUNDER_IDS.indexOf(document.id)
    };
}

router.get("/", async (req, res) => {
    try {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        if (!projectId) {
            return res.status(503).json({ success: false, error: "Founder profiles are temporarily unavailable." });
        }

        const client = UniversalFirestoreService.forProject(projectId);
        const documents = await client.listDocuments("founders");
        const profiles = documents
            .map(toPublicProfile)
            .filter(Boolean)
            .sort((a, b) => a.order - b.order)
            .map(({ order, ...profile }) => profile);

        res.setHeader("Cache-Control", "public, max-age=60");
        res.json({ success: true, profiles });
    } catch (error) {
        console.error("[Founders API] Could not load public profiles:", error.message);
        res.status(503).json({ success: false, error: "Founder profiles are temporarily unavailable." });
    }
});

router.get("/admin", AdminAuthService.requireAdmin(), async (req, res) => {
    try {
        const client = req.adminClient
            || UniversalFirestoreService.forProject(req.targetProjectId || process.env.FIREBASE_PROJECT_ID);
        const documents = await client.listDocuments("founders");
        const profiles = documents
            .filter(document => FOUNDER_IDS.includes(document.id))
            .map(document => ({
                id: document.id,
                name: typeof document.name === "string" ? document.name : "",
                designation: "Co-Founder",
                bio: typeof document.bio === "string" ? document.bio : "",
                imageUrl: isCloudinaryImageUrl(document.imageUrl) ? document.imageUrl : ""
            }));

        res.setHeader("Cache-Control", "no-store");
        res.json({ success: true, profiles });
    } catch (error) {
        console.error("[Founders API] Could not load admin profiles:", error.message);
        res.status(503).json({ success: false, error: "Existing founder profiles could not be loaded." });
    }
});

router.put("/:founderId", AdminAuthService.requireAdmin(), async (req, res) => {
    const { founderId } = req.params;
    if (!FOUNDER_IDS.includes(founderId)) {
        return res.status(404).json({ success: false, error: "Founder profile not found." });
    }

    const body = req.body || {};
    if (Object.keys(body).some(key => !["name", "bio", "image"].includes(key))) {
        return res.status(400).json({ success: false, error: "Unexpected founder profile fields were provided." });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const bio = typeof body.bio === "string" ? body.bio.trim() : "";
    if (!name || name.length > 100) {
        return res.status(400).json({ success: false, error: "A founder name of 1 to 100 characters is required." });
    }
    if (bio.length > 600) {
        return res.status(400).json({ success: false, error: "Founder biographies cannot exceed 600 characters." });
    }

    const image = body.image;
    if (image !== null && image !== undefined) {
        if (!image || typeof image !== "object"
            || Object.keys(image).some(key => !["name", "type", "base64"].includes(key))
            || typeof image.name !== "string"
            || typeof image.type !== "string"
            || typeof image.base64 !== "string"
            || image.base64.length === 0
            || image.base64.length > MAX_BASE64_IMAGE_LENGTH
            || image.base64.length % 4 !== 0
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) {
            return res.status(400).json({ success: false, error: "A valid founder image file is required." });
        }
    }

    try {
        const client = req.adminClient
            || UniversalFirestoreService.forProject(req.targetProjectId || process.env.FIREBASE_PROJECT_ID);
        const existing = await client.getDocument("founders", founderId, { skipCache: true });
        if (existing && !existing._updateTime) {
            return res.status(409).json({
                success: false,
                error: "The existing founder profile could not be version-checked. No changes were saved."
            });
        }

        let uploadedImage = null;
        if (image) {
            const buffer = Buffer.from(image.base64, "base64");
            if (buffer.toString("base64") !== image.base64) {
                return res.status(400).json({ success: false, error: "The founder image encoding is invalid." });
            }

            const validation = StorageVaultService.validateImageBuffer(buffer, image.name, image.type);
            if (!validation.valid) {
                return res.status(400).json({ success: false, error: validation.error });
            }
            uploadedImage = await StorageVaultService.uploadFounderImage(
                buffer,
                image.name,
                image.type,
                founderId
            );
        }

        const existingImageUrl = existing?.imageUrl;
        const imageUrl = uploadedImage?.secureUrl
            || (isCloudinaryImageUrl(existingImageUrl) ? existingImageUrl : null);
        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                error: "Upload a founder image before saving this profile."
            });
        }

        const existingFields = { ...(existing || {}) };
        delete existingFields.id;
        delete existingFields._updateTime;
        delete existingFields._createTime;
        const profile = {
            ...existingFields,
            name,
            designation: "Co-Founder",
            bio,
            imageUrl,
            cloudinaryPublicId: uploadedImage?.publicId || existing?.cloudinaryPublicId || "",
            order: FOUNDER_IDS.indexOf(founderId),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        const writeOptions = existing
            ? { projectId: req.targetProjectId, precondition: { updateTime: existing._updateTime } }
            : { projectId: req.targetProjectId, createOnly: true };

        await client.setDocument("founders", founderId, profile, writeOptions);
        res.json({
            success: true,
            profile: {
                id: founderId,
                name: profile.name,
                designation: profile.designation,
                bio: profile.bio,
                imageUrl: profile.imageUrl
            }
        });
    } catch (error) {
        console.error(`[Founders API] Could not save ${founderId}:`, error.message);
        if (error.code === "CLOUDINARY_NOT_CONFIGURED") {
            return res.status(503).json({ success: false, error: error.message });
        }
        if (error.statusCode === 412 || error.statusCode === 409) {
            return res.status(409).json({
                success: false,
                error: "This profile changed while you were editing it. Reload it and try again."
            });
        }
        if (error.code === "CLOUDINARY_UPLOAD_FAILED") {
            return res.status(502).json({ success: false, error: "The founder image upload failed. Please try again." });
        }
        res.status(500).json({ success: false, error: "The founder profile could not be saved." });
    }
});

export default router;
