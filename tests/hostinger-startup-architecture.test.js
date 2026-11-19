import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

describe("Hostinger Startup Architecture & Production Configuration Suite", () => {

    test("1. Express application in server/app.js can be imported without starting a listener", async () => {
        const { default: importedApp, app } = await import("../server/app.js");
        assert.ok(importedApp, "Default export exists in server/app.js");
        assert.ok(app, "Named export 'app' exists in server/app.js");
        assert.equal(typeof importedApp.listen, "function", "App has .listen method");
        assert.equal(typeof importedApp.use, "function", "App has .use method");
    });

    test("2. Legacy entry point server/server.js re-exports app without starting a listener in test mode", async () => {
        const { default: legacyApp } = await import("../server/server.js");
        assert.ok(legacyApp, "server/server.js exports app");
        assert.equal(typeof legacyApp.listen, "function");
    });

    test("3. Root server.js exists as the canonical production startup file", () => {
        const rootServerPath = path.resolve("server.js");
        assert.ok(fs.existsSync(rootServerPath), "Root server.js exists");
        const content = fs.readFileSync(rootServerPath, "utf8");
        assert.ok(content.includes('import app from "./server/app.js"'), "Imports app from server/app.js");
        assert.ok(content.includes("app.listen"), "Calls app.listen");
        assert.ok(content.includes("uncaughtException"), "Registers uncaughtException listener");
        assert.ok(content.includes("unhandledRejection"), "Registers unhandledRejection listener");
    });

    test("4. package.json specifies canonical main entry point and node >= 18 engine", () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
        assert.equal(pkg.main, "server.js", "package.json main points to canonical server.js");
        assert.ok(pkg.engines && pkg.engines.node, "engines.node constraint specified");
        assert.ok(pkg.engines.node.includes(">=18"), "Requires Node.js >= 18");
        assert.equal(pkg.scripts.start, "node server.js", "npm start runs canonical server.js");
        assert.equal(pkg.scripts["start:server"], "node server.js", "npm run start:server runs canonical server.js");
    });

    test("5. Production CORS allowlist permits https://vidyarthiastra.in and https://www.vidyarthiastra.in", async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevAllowed = process.env.ALLOWED_ORIGINS;
        delete process.env.ALLOWED_ORIGINS;
        process.env.NODE_ENV = "production";

        const { default: prodApp } = await import(`../server/app.js?t=${Date.now()}`);
        const pipePath = `\\\\.\\pipe\\test-cors-prod-${Date.now()}`;
        const server = prodApp.listen(pipePath);

        try {
            // Test primary production domain
            const resPrimary = await makePipeRequest(pipePath, "/health", {
                "Origin": "https://vidyarthiastra.in"
            });
            assert.equal(resPrimary.status, 200);
            assert.equal(resPrimary.headers["access-control-allow-origin"], "https://vidyarthiastra.in");

            // Test www subdomain
            const resWww = await makePipeRequest(pipePath, "/health", {
                "Origin": "https://www.vidyarthiastra.in"
            });
            assert.equal(resWww.status, 200);
            assert.equal(resWww.headers["access-control-allow-origin"], "https://www.vidyarthiastra.in");

            // Test unauthorized origin is rejected
            const resUnauthorized = await makePipeRequest(pipePath, "/health", {
                "Origin": "https://malicious-phishing-site.com"
            });
            assert.notEqual(resUnauthorized.headers["access-control-allow-origin"], "https://malicious-phishing-site.com");
        } finally {
            await new Promise(resolve => server.close(resolve));
            process.env.NODE_ENV = prevEnv;
            if (prevAllowed) process.env.ALLOWED_ORIGINS = prevAllowed;
        }
    });

    test("6. Production server serves /health endpoint with valid JSON architecture status", async () => {
        const { default: prodApp } = await import(`../server/app.js?t=${Date.now()}`);
        const pipePath = `\\\\.\\pipe\\test-health-${Date.now()}`;
        const server = prodApp.listen(pipePath);

        try {
            const res = await makePipeRequest(pipePath, "/health");
            assert.equal(res.status, 200);
            const json = JSON.parse(res.text);
            assert.equal(json.success, true);
            assert.equal(json.primarySearchProvider, "tinyfish");
            assert.ok(json.timestamp);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test("7. Static asset middleware serves www/index.html on root path", async () => {
        const { default: prodApp } = await import(`../server/app.js?t=${Date.now()}`);
        const pipePath = `\\\\.\\pipe\\test-static-${Date.now()}`;
        const server = prodApp.listen(pipePath);

        try {
            const res = await makePipeRequest(pipePath, "/");
            assert.equal(res.status, 200);
            assert.ok(res.text.includes("<!DOCTYPE html>"), "Serves HTML document");
            assert.ok(res.text.includes("VidyarthiAstra") || res.text.includes("vidyarthiastra"), "Contains brand text");
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test("8. Canonical server.js spawns, outputs safe diagnostics, and registers listener in < 3 seconds", async () => {
        const pipePath = `\\\\.\\pipe\\test-prod-spawn-${Date.now()}`;
        const startTime = Date.now();

        const child = spawn(process.execPath, ["server.js"], {
            env: {
                ...process.env,
                PORT: pipePath,
                NODE_ENV: "production"
            },
            cwd: process.cwd()
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", chunk => stdout += chunk.toString());
        child.stderr.on("data", chunk => stderr += chunk.toString());

        try {
            const registered = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout after 3500ms waiting for listener. stdout: ${stdout}, stderr: ${stderr}`));
                }, 3500);

                const interval = setInterval(() => {
                    if (stdout.includes("[STAGE 3] HTTP listener successfully registered")) {
                        clearTimeout(timeout);
                        clearInterval(interval);
                        resolve(true);
                    }
                }, 50);
            });

            const elapsed = Date.now() - startTime;
            assert.ok(registered, "Listener successfully registered");
            assert.ok(elapsed < 3000, `Listener registered in ${elapsed}ms (< 3000ms requirement)`);

            // Verify safe diagnostics
            assert.ok(stdout.includes("[BOOT] argv:"), "Logs process.argv");
            assert.ok(stdout.includes("[BOOT] cwd:"), "Logs process.cwd");
            assert.ok(stdout.includes("[BOOT] NODE_ENV: production"), "Logs NODE_ENV");
            assert.ok(stdout.includes("[BOOT] PORT defined: true"), "Logs PORT presence");
            assert.ok(stdout.includes("[BOOT] PORT type: socket/string"), "Logs PORT type safely");
            assert.ok(!stdout.includes(pipePath), "Masks sensitive socket/internal path in diagnostics");
            assert.ok(!stdout.includes("AI_API_KEY="), "Does not leak secrets");
            assert.ok(!stdout.includes("GROQ_API_KEY="), "Does not leak secrets");
        } finally {
            child.kill("SIGTERM");
        }
    });

    test("9. Legacy entry point server/server.js also starts listener when spawned directly", async () => {
        const pipePath = `\\\\.\\pipe\\test-legacy-spawn-${Date.now()}`;
        const startTime = Date.now();

        const child = spawn(process.execPath, ["server/server.js"], {
            env: {
                ...process.env,
                PORT: pipePath,
                NODE_ENV: "production"
            },
            cwd: process.cwd()
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", chunk => stdout += chunk.toString());
        child.stderr.on("data", chunk => stderr += chunk.toString());

        try {
            const registered = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout after 3500ms waiting for listener. stdout: ${stdout}, stderr: ${stderr}`));
                }, 3500);

                const interval = setInterval(() => {
                    if (stdout.includes("[STAGE 3] HTTP listener successfully registered")) {
                        clearTimeout(timeout);
                        clearInterval(interval);
                        resolve(true);
                    }
                }, 50);
            });

            const elapsed = Date.now() - startTime;
            assert.ok(registered, "Listener successfully registered via server/server.js");
            assert.ok(elapsed < 3000, `Listener registered in ${elapsed}ms (< 3000ms requirement)`);
        } finally {
            child.kill("SIGTERM");
        }
    });

    function makePipeRequest(pipePath, path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: pipePath,
                path,
                method: "GET",
                headers
            }, (res) => {
                let text = "";
                res.on("data", chunk => text += chunk);
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text
                    });
                });
            });
            req.on("error", reject);
            req.end();
        });
    }
});
