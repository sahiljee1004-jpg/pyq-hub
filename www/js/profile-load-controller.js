export const PROFILE_STATES = Object.freeze({
    INITIALIZING: "INITIALIZING",
    AUTHENTICATING: "AUTHENTICATING",
    LOADING_PROFILE: "LOADING_PROFILE",
    SUCCESS: "SUCCESS",
    EMPTY_PROFILE: "EMPTY_PROFILE",
    AUTH_ERROR: "AUTH_ERROR",
    NETWORK_ERROR: "NETWORK_ERROR",
    QUOTA_ERROR: "QUOTA_ERROR",
    SERVER_ERROR: "SERVER_ERROR"
});

export function classifyProfileLoadError(error) {
    const code = typeof error?.code === "string" ? error.code : "";

    if (code === "resource-exhausted") {
        return PROFILE_STATES.QUOTA_ERROR;
    }

    if (["unavailable", "deadline-exceeded", "network-request-failed", "auth/network-request-failed"].includes(code)) {
        return PROFILE_STATES.NETWORK_ERROR;
    }

    if (["permission-denied", "unauthenticated", "auth/user-token-expired", "auth/invalid-user-token"].includes(code)) {
        return PROFILE_STATES.AUTH_ERROR;
    }

    return PROFILE_STATES.SERVER_ERROR;
}

function getErrorCode(error) {
    return typeof error?.code === "string" ? error.code : "unknown";
}

export function createProfileLoadController({
    readProfile,
    onState,
    onUnauthenticated
}) {
    let currentUser = null;
    let inFlight = null;
    let generation = 0;

    function reportState(state, result) {
        if (typeof onState === "function") {
            onState(state, result);
        }
    }

    function startLoad(user) {
        const requestGeneration = ++generation;
        currentUser = user;
        reportState(PROFILE_STATES.AUTHENTICATING, { user });
        reportState(PROFILE_STATES.LOADING_PROFILE, { user });

        let trackedRequest;
        trackedRequest = (async () => {
            let result;

            try {
                const snapshot = await readProfile(user.uid);
                if (!snapshot || typeof snapshot.exists !== "function") {
                    throw Object.assign(new Error("Invalid profile response."), {
                        code: "invalid-profile-response"
                    });
                }

                if (!snapshot.exists()) {
                    result = { state: PROFILE_STATES.EMPTY_PROFILE };
                } else {
                    const data = snapshot.data();
                    if (!data || typeof data !== "object" || Array.isArray(data)) {
                        throw Object.assign(new Error("Invalid profile document."), {
                            code: "invalid-profile-response"
                        });
                    }
                    result = { state: PROFILE_STATES.SUCCESS, data };
                }
            } catch (error) {
                result = {
                    state: classifyProfileLoadError(error),
                    errorCode: getErrorCode(error)
                };
            }

            if (requestGeneration !== generation) {
                return null;
            }

            if (result.errorCode === "unauthenticated") {
                currentUser = null;
            }

            reportState(result.state, { ...result, user });
            return result;
        })().finally(() => {
            if (requestGeneration === generation && inFlight === trackedRequest) {
                inFlight = null;
            }
        });

        inFlight = trackedRequest;
        return trackedRequest;
    }

    function onAuthState(user) {
        if (!user || typeof user.uid !== "string" || !user.uid) {
            generation += 1;
            currentUser = null;
            inFlight = null;
            if (typeof onUnauthenticated === "function") {
                onUnauthenticated();
            }
            return Promise.resolve(null);
        }

        if (currentUser?.uid === user.uid) {
            return inFlight || Promise.resolve(null);
        }

        return startLoad(user);
    }

    function retry() {
        if (!currentUser || inFlight) {
            return inFlight || Promise.resolve(null);
        }
        return startLoad(currentUser);
    }

    function onAuthError(error) {
        generation += 1;
        currentUser = null;
        inFlight = null;
        reportState(PROFILE_STATES.AUTH_ERROR, {
            errorCode: getErrorCode(error)
        });
    }

    return {
        onAuthState,
        onAuthError,
        retry,
        canRetry: () => Boolean(currentUser)
    };
}
