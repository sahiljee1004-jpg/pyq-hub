import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { UniversalFirestoreService } from "./universalFirestoreService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../../uploads/vault");
const LOCAL_STORE_FILE = path.join(DATA_DIR, "admin_roles.json");

export const ROLES = {
    SUPER_ADMIN: "super_admin",
    CONTENT_ADMIN: "content_admin",
    USER: "user"
};

export const ADMIN_PERMISSIONS = {
    [ROLES.SUPER_ADMIN]: [
        "admin:read",
        "admin:stats",
        "import:upload",
        "import:review",
        "import:publish",
        "users:read",
        "users:assign",
        "users:revoke",
        "audit:read"
    ],
    [ROLES.CONTENT_ADMIN]: [
        "admin:read",
        "admin:stats",
        "import:upload",
        "import:review",
        "import:publish"
    ],
    [ROLES.USER]: []
};

/**
 * Admin User Management Service
 * 
 * Provides server-authoritative role assignment, revocation safeguards,
 * audit trails, and first-super-admin bootstrap procedures.
 */
export class AdminUserService {
    static _adminRoles = new Map();
    static _auditLogs = [];
    static _initialized = false;

    /**
     * Initialize service and load persisted records from disk/Firestore
     */
    static async init() {
        if (this._initialized) return;

        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            if (fs.existsSync(LOCAL_STORE_FILE)) {
                const raw = fs.readFileSync(LOCAL_STORE_FILE, "utf8");
                const data = JSON.parse(raw);
                if (Array.isArray(data.roles)) {
                    data.roles.forEach(r => this._adminRoles.set(r.uid, r));
                }
                if (Array.isArray(data.auditLogs)) {
                    this._auditLogs = data.auditLogs;
                }
            }
        } catch (err) {
            console.warn("[AdminUserService] Local store read notice:", err.message);
        }

        // Check environment variable fallback seeds
        const superAdminUids = (process.env.SUPER_ADMIN_UIDS || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);

        for (const uid of superAdminUids) {
            if (!this._adminRoles.has(uid)) {
                this._adminRoles.set(uid, {
                    uid,
                    email: process.env.SUPER_ADMIN_EMAIL || `superadmin_${uid.substring(0, 6)}@system.local`,
                    name: "System Super Admin",
                    role: ROLES.SUPER_ADMIN,
                    status: "active",
                    assignedBy: "env_configuration",
                    assignedAt: new Date().toISOString(),
                    reason: "Seeded from SUPER_ADMIN_UIDS environment variable"
                });
            }
        }

        this._initialized = true;
    }

    /**
     * Persist current in-memory records to disk and Firestore
     */
    static async _persist() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            const payload = {
                roles: Array.from(this._adminRoles.values()),
                auditLogs: this._auditLogs
            };
            fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(payload, null, 2), "utf8");
        } catch (err) {
            console.warn("[AdminUserService] Local store save notice:", err.message);
        }
    }

    /**
     * Check if first-admin bootstrap is available
     * Returns true ONLY if zero active super-admins exist in the system.
     */
    static async isBootstrapAvailable() {
        await this.init();
        const activeSuperAdmins = Array.from(this._adminRoles.values()).filter(
            r => r.role === ROLES.SUPER_ADMIN && r.status === "active"
        );
        return activeSuperAdmins.length === 0;
    }

    /**
     * Perform one-time initial bootstrap of the first super-admin
     */
    static async bootstrapFirstAdmin({ uid, email, name, secret, actor = "system_bootstrap" }) {
        await this.init();

        if (!uid || typeof uid !== "string" || uid.trim().length === 0) {
            throw new Error("A valid Firebase UID is required to bootstrap the first administrator.");
        }

        const isAvailable = await this.isBootstrapAvailable();
        if (!isAvailable) {
            throw new Error("Bootstrap is permanently disabled: at least one active super-admin already exists.");
        }

        // Verify bootstrap secret if configured on server
        const configuredSecret = process.env.BOOTSTRAP_SECRET;
        if (configuredSecret) {
            if (!secret || typeof secret !== "string") {
                throw new Error("A valid bootstrap secret is required.");
            }
            const expected = Buffer.from(configuredSecret);
            const provided = Buffer.from(secret);
            if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
                throw new Error("Invalid bootstrap secret.");
            }
        }

        const cleanUid = uid.trim();
        const cleanEmail = (email || "").trim().toLowerCase();
        const cleanName = (name || cleanEmail || "First Super Admin").trim();

        const record = {
            uid: cleanUid,
            email: cleanEmail,
            name: cleanName,
            role: ROLES.SUPER_ADMIN,
            status: "active",
            assignedBy: actor,
            assignedAt: new Date().toISOString(),
            reason: "Initial system bootstrap"
        };

        this._adminRoles.set(cleanUid, record);

        // Record audit trail
        const auditEntry = {
            id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            action: "bootstrap_first_admin",
            actor,
            targetUid: cleanUid,
            targetEmail: cleanEmail,
            previousRole: null,
            newRole: ROLES.SUPER_ADMIN,
            reason: "Initial system bootstrap",
            timestamp: new Date().toISOString()
        };
        this._auditLogs.unshift(auditEntry);

        await this._persist();

        // Sync with Firestore
        try {
            await UniversalFirestoreService.setDocument("adminRoles", cleanUid, record);
            await UniversalFirestoreService.setDocument("users", cleanUid, {
                uid: cleanUid,
                email: cleanEmail,
                name: cleanName,
                role: ROLES.SUPER_ADMIN,
                updatedAt: new Date().toISOString()
            });
            await UniversalFirestoreService.setDocument("adminAuditLogs", auditEntry.id, auditEntry);
        } catch (err) {
            console.warn("[AdminUserService] Firestore sync notice during bootstrap:", err.message);
        }

        return {
            success: true,
            message: "First super-admin bootstrapped successfully. Bootstrap is now permanently disabled.",
            user: record
        };
    }

    /**
     * Get authoritative role and administrative record for a given UID
     */
    static async getUserRole(uid) {
        await this.init();
        if (!uid || typeof uid !== "string") return null;

        const record = this._adminRoles.get(uid);
        if (record) {
            if (record.status === "active") {
                return record;
            }
            // Explicitly revoked: server revocation overrides environment fallback
            return null;
        }

        // Check if user is in environment-based fallback lists
        const superAdminUids = new Set(
            (process.env.SUPER_ADMIN_UIDS || "")
                .split(",")
                .map(s => s.trim())
                .filter(Boolean)
        );
        if (superAdminUids.has(uid)) {
            return {
                uid,
                role: ROLES.SUPER_ADMIN,
                status: "active",
                assignedBy: "env_configuration"
            };
        }

        const contentAdminUids = new Set(
            (process.env.CONTENT_ADMIN_UIDS || process.env.ADMIN_UIDS || "")
                .split(",")
                .map(s => s.trim())
                .filter(Boolean)
        );
        if (contentAdminUids.has(uid)) {
            return {
                uid,
                role: ROLES.CONTENT_ADMIN,
                status: "active",
                assignedBy: "env_configuration"
            };
        }

        return null;
    }

    /**
     * List all administrators and their roles
     */
    static async listAdminUsers() {
        await this.init();
        return Array.from(this._adminRoles.values()).map(r => ({
            uid: r.uid,
            email: r.email || "",
            name: r.name || "",
            role: r.role,
            status: r.status,
            assignedBy: r.assignedBy,
            assignedAt: r.assignedAt,
            reason: r.reason || ""
        }));
    }

    /**
     * Assign or update an administrative role for a user
     */
    static async assignRole({ targetUid, targetEmail, targetName, newRole, actor, reason }) {
        await this.init();

        if (!targetUid || typeof targetUid !== "string" || targetUid.trim().length === 0) {
            throw new Error("A valid target Firebase UID is required.");
        }
        if (![ROLES.SUPER_ADMIN, ROLES.CONTENT_ADMIN, ROLES.USER].includes(newRole)) {
            throw new Error(`Invalid role '${newRole}'. Allowed roles: ${ROLES.SUPER_ADMIN}, ${ROLES.CONTENT_ADMIN}, ${ROLES.USER}.`);
        }
        if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
            throw new Error("An audit reason of at least 5 characters is required for role modification.");
        }

        const cleanUid = targetUid.trim();
        const existing = this._adminRoles.get(cleanUid);
        const previousRole = (existing && existing.status === "active") ? existing.role : ROLES.USER;

        // If revoking to ordinary user
        if (newRole === ROLES.USER) {
            return this.revokeRole({ targetUid: cleanUid, actor, reason });
        }

        // Downgrade protection: If existing was super_admin and new role is content_admin, verify not the last super-admin
        if (previousRole === ROLES.SUPER_ADMIN && newRole !== ROLES.SUPER_ADMIN) {
            const activeSuperAdmins = Array.from(this._adminRoles.values()).filter(
                r => r.role === ROLES.SUPER_ADMIN && r.status === "active" && r.uid !== cleanUid
            );
            if (activeSuperAdmins.length === 0) {
                throw new Error("Cannot downgrade the last active super-admin. Appoint another active super-admin first.");
            }
        }

        const record = {
            uid: cleanUid,
            email: (targetEmail || existing?.email || "").trim().toLowerCase(),
            name: (targetName || existing?.name || cleanUid).trim(),
            role: newRole,
            status: "active",
            assignedBy: actor,
            assignedAt: new Date().toISOString(),
            reason: reason.trim()
        };

        this._adminRoles.set(cleanUid, record);

        const auditEntry = {
            id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            action: previousRole === ROLES.USER ? "grant_role" : "change_role",
            actor,
            targetUid: cleanUid,
            targetEmail: record.email,
            previousRole,
            newRole,
            reason: reason.trim(),
            timestamp: new Date().toISOString()
        };
        this._auditLogs.unshift(auditEntry);

        await this._persist();

        // Sync with Firestore
        try {
            await UniversalFirestoreService.setDocument("adminRoles", cleanUid, record);
            await UniversalFirestoreService.setDocument("users", cleanUid, {
                uid: cleanUid,
                email: record.email,
                name: record.name,
                role: newRole,
                updatedAt: new Date().toISOString()
            });
            await UniversalFirestoreService.setDocument("adminAuditLogs", auditEntry.id, auditEntry);
        } catch (err) {
            console.warn("[AdminUserService] Firestore sync notice during role assignment:", err.message);
        }

        return {
            success: true,
            message: `Role ${newRole} successfully assigned to ${cleanUid}.`,
            user: record
        };
    }

    /**
     * Revoke administrator privileges from a user
     */
    static async revokeRole({ targetUid, actor, reason }) {
        await this.init();

        if (!targetUid || typeof targetUid !== "string" || targetUid.trim().length === 0) {
            throw new Error("A valid target Firebase UID is required.");
        }
        if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
            throw new Error("An audit reason of at least 5 characters is required for revocation.");
        }

        const cleanUid = targetUid.trim();
        const existing = this._adminRoles.get(cleanUid);

        if (!existing || existing.status !== "active") {
            throw new Error(`User ${cleanUid} does not have an active administrator role.`);
        }

        // CRITICAL SAFEGUARD: Prevent revocation of the last active super_admin!
        if (existing.role === ROLES.SUPER_ADMIN) {
            const remainingSuperAdmins = Array.from(this._adminRoles.values()).filter(
                r => r.role === ROLES.SUPER_ADMIN && r.status === "active" && r.uid !== cleanUid
            );
            if (remainingSuperAdmins.length === 0) {
                throw new Error("Cannot revoke privileges: This user is the LAST active super-admin. Appoint another active super-admin before revoking.");
            }
        }

        const previousRole = existing.role;
        existing.status = "revoked";
        existing.role = ROLES.USER;
        existing.revokedBy = actor;
        existing.revokedAt = new Date().toISOString();
        existing.revocationReason = reason.trim();

        this._adminRoles.set(cleanUid, existing);

        const auditEntry = {
            id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            action: "revoke_role",
            actor,
            targetUid: cleanUid,
            targetEmail: existing.email || "",
            previousRole,
            newRole: ROLES.USER,
            reason: reason.trim(),
            timestamp: new Date().toISOString()
        };
        this._auditLogs.unshift(auditEntry);

        await this._persist();

        // Sync with Firestore
        try {
            await UniversalFirestoreService.setDocument("adminRoles", cleanUid, existing);
            await UniversalFirestoreService.setDocument("users", cleanUid, {
                uid: cleanUid,
                role: ROLES.USER,
                updatedAt: new Date().toISOString()
            });
            await UniversalFirestoreService.setDocument("adminAuditLogs", auditEntry.id, auditEntry);
        } catch (err) {
            console.warn("[AdminUserService] Firestore sync notice during role revocation:", err.message);
        }

        return {
            success: true,
            message: `Administrator access successfully revoked for ${cleanUid}.`,
            user: existing
        };
    }

    /**
     * Retrieve chronological audit log entries
     */
    static async getAuditLogs({ limit = 50 } = {}) {
        await this.init();
        return this._auditLogs.slice(0, Math.min(limit, 200));
    }

    /**
     * Reset service state (for unit and integration tests)
     */
    static resetForTesting() {
        this._adminRoles.clear();
        this._auditLogs = [];
        this._initialized = true;
    }
}
