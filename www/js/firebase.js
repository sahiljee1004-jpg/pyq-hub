import { auth, db, googleProvider } from "./firebase-config.js";

if (typeof window !== "undefined") {
    window.auth = auth;
    window.db = db;
    window.googleProvider = googleProvider;
}

export {
    auth,
    db,
    googleProvider
};