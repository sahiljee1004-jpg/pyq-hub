import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VAULT_DIR = path.resolve(__dirname, "../../../uploads/vault");

const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50MB limit per document
const MIN_PDF_SIZE_BYTES = 64; // Minimum non-empty PDF file size
const MAX_FOUNDER_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const FOUNDER_IMAGE_MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
};

export class StorageVaultService {
    static init() {
        if (!fs.existsSync(VAULT_DIR)) {
            fs.mkdirSync(VAULT_DIR, { recursive: true });
        }
    }

    /**
     * Compute SHA-256 hash of a buffer
     */
    static computeHash(buffer) {
        return crypto.createHash("sha256").update(buffer).digest("hex");
    }

    /**
     * Validate PDF buffer integrity and magic bytes
     */
    static validatePdfBuffer(buffer, originalFilename = "document.pdf") {
        if (!Buffer.isBuffer(buffer)) {
            return { valid: false, error: "Invalid file buffer received" };
        }

        if (buffer.length < MIN_PDF_SIZE_BYTES) {
            return { valid: false, error: "File is empty or too small to be a valid document" };
        }

        if (buffer.length > MAX_PDF_SIZE_BYTES) {
            return { valid: false, error: `File exceeds maximum allowed size of ${MAX_PDF_SIZE_BYTES / (1024 * 1024)}MB` };
        }

        // Verify PDF Magic Bytes: "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
        const header = buffer.subarray(0, 5).toString("ascii");
        if (header !== "%PDF-") {
            // Also check first 1024 bytes in case of leading BOM or comments
            const firstChunk = buffer.subarray(0, 1024).toString("latin1");
            if (!firstChunk.includes("%PDF-")) {
                return { valid: false, error: "Invalid file content: Missing official PDF magic byte signature (%PDF-)" };
            }
        }

        const ext = path.extname(originalFilename || "").toLowerCase();
        if (ext && ext !== ".pdf") {
            return { valid: false, error: `Invalid file extension (${ext}). Only .pdf documents are supported.` };
        }

        return { valid: true };
    }

    /**
     * Upload buffer to Cloudinary if configured
     */
    static async uploadToCloudinary(buffer, filename, folder = "vidyarthiastra/pyq_vault") {
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret || (process.env.NODE_ENV === "test" && !process.env.FORCE_CLOUDINARY_TEST)) {
            return null; // Cloudinary not configured or offline test mode, fallback to local vault
        }

        try {
            const timestamp = Math.floor(Date.now() / 1000);
            const publicId = `${folder}/${path.parse(filename).name}_${timestamp}`;
            
            // Generate Cloudinary API signature
            const signatureParams = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
            const signature = crypto.createHash("sha1").update(signatureParams).digest("hex");

            const formData = new FormData();
            formData.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
            formData.append("api_key", apiKey);
            formData.append("timestamp", String(timestamp));
            formData.append("folder", folder);
            formData.append("public_id", publicId);
            formData.append("signature", signature);

            const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`;
            const res = await fetch(uploadUrl, { method: "POST", body: formData });

            if (!res.ok) {
                const errBody = await res.text();
                console.warn("[StorageVaultService] Cloudinary upload rejected:", errBody);
                return null;
            }

            const data = await res.json();
            return {
                provider: "cloudinary",
                secureUrl: data.secure_url,
                publicId: data.public_id,
                bytes: data.bytes
            };
        } catch (err) {
            console.warn("[StorageVaultService] Cloudinary error:", err.message);
            return null;
        }
    }

    static validateImageBuffer(buffer, originalFilename, contentType) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            return { valid: false, error: "The image file is empty or invalid." };
        }

        if (buffer.length > MAX_FOUNDER_IMAGE_SIZE_BYTES) {
            return { valid: false, error: "Founder images must be 5 MB or smaller." };
        }

        const extension = path.extname(originalFilename || "").toLowerCase();
        if (!FOUNDER_IMAGE_MIME_TYPES[extension] || FOUNDER_IMAGE_MIME_TYPES[extension] !== contentType) {
            return { valid: false, error: "Only matching JPG, JPEG, PNG, and WebP image files are supported." };
        }

        const hasJpegSignature = buffer.length >= 3
            && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
        const hasPngSignature = buffer.length >= 8
            && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const hasWebpSignature = buffer.length >= 12
            && buffer.toString("ascii", 0, 4) === "RIFF"
            && buffer.toString("ascii", 8, 12) === "WEBP";
        const signatureMatchesType = contentType === "image/jpeg" ? hasJpegSignature
            : contentType === "image/png" ? hasPngSignature
                : contentType === "image/webp" ? hasWebpSignature
                    : false;

        if (!signatureMatchesType) {
            return { valid: false, error: "The image content does not match its file type." };
        }

        return { valid: true };
    }

    static async uploadFounderImage(buffer, filename, contentType, founderId) {
        const validation = this.validateImageBuffer(buffer, filename, contentType);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        if (!/^founder-[1-3]$/.test(founderId || "")) {
            throw new Error("Invalid founder profile identifier.");
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        if (!cloudName || !apiKey || !apiSecret) {
            const error = new Error("Cloudinary image uploads are not configured on this server.");
            error.code = "CLOUDINARY_NOT_CONFIGURED";
            throw error;
        }
        if (process.env.NODE_ENV === "test" && !process.env.FORCE_CLOUDINARY_TEST) {
            const error = new Error("Cloudinary uploads are disabled in test mode.");
            error.code = "CLOUDINARY_DISABLED_IN_TEST";
            throw error;
        }

        const folder = "vidyarthiastra/founders";
        const timestamp = Math.floor(Date.now() / 1000);
        const publicId = `${founderId}_${timestamp}_${crypto.randomUUID()}`;
        const signatureParams = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature = crypto.createHash("sha1").update(signatureParams).digest("hex");
        const formData = new FormData();
        formData.append("file", new Blob([buffer], { type: contentType }), filename);
        formData.append("api_key", apiKey);
        formData.append("timestamp", String(timestamp));
        formData.append("folder", folder);
        formData.append("public_id", publicId);
        formData.append("signature", signature);

        let response;
        try {
            response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
                method: "POST",
                body: formData
            });
        } catch {
            const error = new Error("Cloudinary image upload could not reach the service.");
            error.code = "CLOUDINARY_UPLOAD_FAILED";
            throw error;
        }
        if (!response.ok) {
            const error = new Error(`Cloudinary image upload failed (HTTP ${response.status}).`);
            error.code = "CLOUDINARY_UPLOAD_FAILED";
            throw error;
        }

        let result;
        try {
            result = await response.json();
        } catch {
            const error = new Error("Cloudinary returned an invalid image response.");
            error.code = "CLOUDINARY_UPLOAD_FAILED";
            throw error;
        }
        let secureUrl;
        try {
            secureUrl = new URL(result.secure_url);
        } catch {
            throw new Error("Cloudinary returned an invalid image URL.");
        }
        if (secureUrl.protocol !== "https:" || secureUrl.hostname !== "res.cloudinary.com") {
            throw new Error("Cloudinary returned an unexpected image host.");
        }

        return {
            secureUrl: secureUrl.href,
            publicId: result.public_id,
            bytes: result.bytes
        };
    }

    /**
     * Store uploaded file securely in vault (Cloudinary or local disk vault)
     */
    static async storeDocument({ buffer, originalFilename, docType = "document" }) {
        this.init();

        const validation = this.validatePdfBuffer(buffer, originalFilename);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        const hash = this.computeHash(buffer);
        const base = path.basename(originalFilename || "document.pdf");
        const safeBaseName = base
            .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
            .substring(0, 100);

        // Security gate: Answer keys are strictly confidential and must NEVER be uploaded to public cloud storage
        const shouldUploadCloud = docType !== "answer_key";
        const cloudUpload = shouldUploadCloud ? await this.uploadToCloudinary(buffer, `${docType}_${safeBaseName}`) : null;

        // Store local copy in vault for resilient local processing & offline dev
        const vaultFileName = `${hash.substring(0, 16)}_${Date.now()}_${safeBaseName}`;
        const localVaultPath = path.join(VAULT_DIR, vaultFileName);
        fs.writeFileSync(localVaultPath, buffer);

        return {
            hash,
            originalFilename: base,
            docType,
            sizeBytes: buffer.length,
            localVaultPath,
            remoteUrl: cloudUpload ? cloudUpload.secureUrl : null,
            storageProvider: cloudUpload ? "cloudinary" : "local_vault",
            storedAt: new Date().toISOString()
        };
    }

    /**
     * Read buffer from local vault or remote URL
     */
    static async retrieveDocumentBuffer(storageRef) {
        if (!storageRef) {
            throw new Error("No storage reference provided");
        }

        // If local path exists
        if (storageRef.localVaultPath && fs.existsSync(storageRef.localVaultPath)) {
            return fs.readFileSync(storageRef.localVaultPath);
        }

        // If remote URL available
        if (storageRef.remoteUrl && storageRef.remoteUrl.startsWith("https://")) {
            const res = await fetch(storageRef.remoteUrl);
            if (!res.ok) {
                throw new Error(`Failed to fetch PDF from remote URL (${res.status})`);
            }
            const arrayBuffer = await res.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }

        throw new Error("Target document could not be located in local vault or remote storage.");
    }

    /**
     * Remove a storage asset safely (supports local vault files and Firebase Storage emulator/cloud)
     */
    static async removeStorageAsset(assetRef) {
        if (!assetRef) return false;

        let localPath = null;
        let storageKey = null;

        if (typeof assetRef === "string") {
            if (assetRef.startsWith("gs://") || assetRef.startsWith("storage:") || assetRef.includes("firebasestorage") || (!fs.existsSync(assetRef) && !path.isAbsolute(assetRef))) {
                storageKey = assetRef;
            } else {
                localPath = assetRef;
            }
        } else if (typeof assetRef === "object") {
            localPath = assetRef.localVaultPath || null;
            storageKey = assetRef.storagePath || assetRef.firebaseStoragePath || assetRef.remoteUrl || null;
        }

        let anyRemoved = false;

        // 1. Clean up local disk vault copy if present
        if (localPath && typeof localPath === "string") {
            try {
                const resolvedPath = path.resolve(localPath);
                const allowedBase = path.resolve(__dirname, "../../../uploads");
                if (resolvedPath.startsWith(allowedBase) && fs.existsSync(resolvedPath)) {
                    fs.unlinkSync(resolvedPath);
                    anyRemoved = true;
                }
            } catch (err) {
                console.warn(`[StorageVaultService] Notice removing local file ${localPath}:`, err.message);
            }
        }

        // 2. Clean up Firebase Storage object if emulator or cloud is active
        const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
        if (storageKey && storageHost) {
            try {
                const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "demo-vidyarthiastra";
                const bucket = `${projectId}.appspot.com`;

                let cleanKey = storageKey;
                if (cleanKey.startsWith("gs://")) {
                    const withoutGs = cleanKey.replace(/^gs:\/\/[^\/]+\//, "");
                    cleanKey = withoutGs;
                } else if (cleanKey.includes("/o/")) {
                    const parts = cleanKey.split("/o/");
                    cleanKey = decodeURIComponent(parts[1].split("?")[0]);
                }

                cleanKey = cleanKey.replace(/^\/+/, "");

                const delUrl = `http://${storageHost}/v0/b/${bucket}/o/${encodeURIComponent(cleanKey)}`;
                const res = await fetch(delUrl, { method: "DELETE" });
                if (res.ok || res.status === 204 || res.status === 404) {
                    anyRemoved = true;
                }
            } catch (storageErr) {
                console.warn(`[StorageVaultService] Notice removing storage asset ${storageKey}:`, storageErr.message);
            }
        }

        return anyRemoved;
    }

    /**
     * Remove a draft vault file safely (backward-compatible delegate)
     */
    static async removeDraftFile(filePath, jobId = null) {
        if (!filePath) return false;
        return this.removeStorageAsset(filePath);
    }
}
