#!/usr/bin/env node
/**
 * VidyarthiAstra — Admin Access Guide & Retired Bootstrap Notice
 * 
 * IMPORTANT ARCHITECTURAL POLICY:
 * In accordance with the Firestore-Managed Admin Access specification,
 * script-based and CLI-based privilege escalation has been retired.
 * 
 * The ONLY authoritative way to grant or revoke administrator access
 * is manual modification of the user's document in Cloud Firestore via the Firebase Console:
 * 
 * Collection: users
 * Document ID: <FIREBASE_UID>
 * Field: role
 * Type: string
 * Value: "admin" (to grant) or "user" (to revoke)
 */

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].substring(2);
            const val = (i + 1 < args.length && !args[i + 1].startsWith("--")) ? args[++i] : "true";
            parsed[key] = val;
        }
    }
    return parsed;
}

function main() {
    const args = parseArgs();
    const uid = args.uid || "<FIREBASE_UID>";

    console.log(`
========================================================================
VIDYARTHIASTRA — FIRESTORE-MANAGED ADMIN ACCESS
========================================================================

[NOTICE: CLI BOOTSTRAP RETIRED]
Script-based promotion and local bootstrap secrets are permanently retired.
No local script or API endpoint is permitted to grant admin privileges.

HOW TO GRANT ADMIN ACCESS MANUALLY:
1. Open the Firebase Console:
   https://console.firebase.google.com/
2. Go to: Firestore Database -> Data.
3. Open the "users" collection.
4. Select or create the document matching the user's UID:
   Path: users/${uid}
5. Add or update the field:
   Field Name: role
   Type:       string
   Value:      admin
6. Click Save.

HOW TO REVOKE ADMIN ACCESS:
1. In the same document (users/${uid}), update:
   Field Name: role
   Value:      user
2. Or delete the "role" field entirely.
3. Click Save. The user loses admin access immediately on their next request.

========================================================================
`);
}

main();
