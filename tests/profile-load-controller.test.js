import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyProfileLoadError,
    createProfileLoadController,
    PROFILE_STATES
} from "../www/js/profile-load-controller.js";

const user = { uid: "authenticated-user-1", displayName: "Example Student" };

function snapshot(data) {
    return {
        exists: () => true,
        data: () => data
    };
}

test("renders data from the authenticated user's Firestore document", async () => {
    const states = [];
    const requestedUids = [];
    const loader = createProfileLoadController({
        readProfile: async (uid) => {
            requestedUids.push(uid);
            return snapshot({ name: "Example Student", email: "student@example.com" });
        },
        onState: (state, result) => states.push({ state, result })
    });

    await loader.onAuthState(user);

    assert.deepEqual(requestedUids, [user.uid]);
    assert.deepEqual(states.map(({ state }) => state), [
        PROFILE_STATES.AUTHENTICATING,
        PROFILE_STATES.LOADING_PROFILE,
        PROFILE_STATES.SUCCESS
    ]);
    assert.equal(states[2].result.data.name, "Example Student");
});

test("reports a missing profile document as an empty profile", async () => {
    const states = [];
    const loader = createProfileLoadController({
        readProfile: async () => ({ exists: () => false }),
        onState: (state) => states.push(state)
    });

    await loader.onAuthState(user);

    assert.equal(states.at(-1), PROFILE_STATES.EMPTY_PROFILE);
});

test("classifies Firestore network, quota, permission, and server errors", async () => {
    const cases = [
        [{ code: "unavailable" }, PROFILE_STATES.NETWORK_ERROR],
        [{ code: "resource-exhausted" }, PROFILE_STATES.QUOTA_ERROR],
        [{ code: "permission-denied" }, PROFILE_STATES.AUTH_ERROR],
        [{ code: "internal" }, PROFILE_STATES.SERVER_ERROR]
    ];

    for (const [error, expectedState] of cases) {
        const states = [];
        const loader = createProfileLoadController({
            readProfile: async () => {
                throw error;
            },
            onState: (state, result) => states.push({ state, result })
        });

        await loader.onAuthState(user);

        assert.equal(states.at(-1).state, expectedState);
        assert.equal(loader.canRetry(), true);
    }
});

test("deduplicates concurrent initialization and allows an explicit retry", async () => {
    const resolvers = [];
    let readCount = 0;
    const loader = createProfileLoadController({
        readProfile: () => {
            readCount += 1;
            return new Promise((resolve) => resolvers.push(resolve));
        },
        onState: () => {}
    });

    const firstLoad = loader.onAuthState(user);
    const duplicateLoad = loader.onAuthState(user);
    assert.equal(firstLoad, duplicateLoad);
    assert.equal(readCount, 1);

    resolvers[0](snapshot({ name: "Example Student" }));
    await firstLoad;
    assert.equal(loader.canRetry(), true);

    const retry = loader.retry();
    assert.equal(readCount, 2);
    resolvers[1](snapshot({ name: "Updated Student" }));
    await retry;
});

test("recovers from a temporary quota failure on retry", async () => {
    let quotaExceeded = true;
    const states = [];
    const loader = createProfileLoadController({
        readProfile: async () => {
            if (quotaExceeded) {
                const error = new Error("Quota exceeded.");
                error.code = "resource-exhausted";
                throw error;
            }
            return snapshot({ name: "Recovered Student" });
        },
        onState: (state) => states.push(state)
    });

    await loader.onAuthState(user);
    assert.equal(states.at(-1), PROFILE_STATES.QUOTA_ERROR);
    assert.equal(loader.canRetry(), true);

    quotaExceeded = false;
    await loader.retry();
    assert.equal(states.at(-1), PROFILE_STATES.SUCCESS);
});

test("ignores stale results after the authenticated user changes", async () => {
    const resolvers = [];
    const renderedNames = [];
    const loader = createProfileLoadController({
        readProfile: () => new Promise((resolve) => resolvers.push(resolve)),
        onState: (state, result) => {
            if (state === PROFILE_STATES.SUCCESS) {
                renderedNames.push(result.data.name);
            }
        }
    });

    const firstLoad = loader.onAuthState(user);
    const secondUser = { uid: "authenticated-user-2" };
    const secondLoad = loader.onAuthState(secondUser);

    resolvers[1](snapshot({ name: "Current Student" }));
    await secondLoad;
    resolvers[0](snapshot({ name: "Stale Student" }));
    await firstLoad;

    assert.deepEqual(renderedNames, ["Current Student"]);
});

test("maps malformed documents to a server error and unauthenticated state to login handling", async () => {
    const states = [];
    const unauthenticatedUsers = [];
    const malformedLoader = createProfileLoadController({
        readProfile: async () => ({ exists: () => true, data: () => null }),
        onState: (state) => states.push(state)
    });

    await malformedLoader.onAuthState(user);
    assert.equal(states.at(-1), PROFILE_STATES.SERVER_ERROR);

    const unauthenticatedLoader = createProfileLoadController({
        readProfile: async () => snapshot({}),
        onState: () => {},
        onUnauthenticated: () => unauthenticatedUsers.push(true)
    });

    await unauthenticatedLoader.onAuthState(null);
    assert.deepEqual(unauthenticatedUsers, [true]);
    assert.equal(classifyProfileLoadError({ code: "unauthenticated" }), PROFILE_STATES.AUTH_ERROR);
});
