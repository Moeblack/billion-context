import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** The dsh Context tab (#3862) polls `/__bili/plugin/status` CROSS-ORIGIN from
 *  the dsh web app (e.g. http://127.0.0.1:3080) and treats a rejected fetch as
 *  "degraded" — the copy that says this dsh process is NOT bound to a bili
 *  proxy. A brand-new conversation with no session yet is served a 404, so that
 *  answer MUST carry access-control-allow-origin too: without it the browser
 *  withholds the response body, `fetch().catch` fires, and an up-and-reachable
 *  proxy is reported as unbound. The 200 branches already echo; this pins the
 *  404 branch (and keeps the unknown-origin 403 echo-free). */

interface Resp {
    status: number;
    acao: string | undefined;
    contentType: string | undefined;
    body: string;
}

function request(
    port: number,
    opts: { path: string; headers: Record<string, string>; method?: string; body?: string },
): Promise<Resp> {
    const { promise, resolve, reject } = Promise.withResolvers<Resp>();
    const req = http.request(
        { host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
        (res) => {
            let body = "";
            res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                acao: res.headers["access-control-allow-origin"] as string | undefined,
                contentType: res.headers["content-type"] as string | undefined,
                body,
            }));
        },
    );
    req.once("error", reject);
    req.end(opts.body);
    return promise;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function withProxy(fn: (port: number, trusted: string) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-status-cors-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const actualPort = (proxy.address() as { port: number }).port;
    try {
        await fn(actualPort, `127.0.0.1:${actualPort}`);
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        try { rmrf(root); } catch { /* best-effort */ }
    }
}

test("plugin/status: no-session 404 is readable cross-origin and still refuses foreign origins", async () => {
    await withProxy(async (port, trusted) => {
        const paneOrigin = "http://127.0.0.1:3080";
        const fresh = `fresh-conversation-${process.pid}-${Date.now()}`;
        // Exactly the Context tab's first poll for a brand-new conversation.
        const poll = await request(port, {
            path: `/__bili/plugin/status?conversationId=${encodeURIComponent(fresh)}&fallback=latest`,
            headers: { host: trusted, origin: paneOrigin },
        });
        assert.equal(poll.status, 404, "a brand-new conversation has no session yet");
        assert.match(String(poll.contentType ?? ""), /application\/json/, "404 carries the JSON error body");
        assert.equal(poll.acao, paneOrigin, "the 404 must echo the admitted origin or the browser reports the proxy as unbound");
        assert.equal(JSON.parse(poll.body).ok, false, "body stays the honest no-session answer");

        // The exact-id form (no fallback) is the same branch and must echo too.
        const exact = await request(port, {
            path: `/__bili/plugin/status?conversationId=${encodeURIComponent(fresh)}`,
            headers: { host: trusted, origin: paneOrigin },
        });
        assert.equal(exact.status, 404);
        assert.equal(exact.acao, paneOrigin, "exact-id 404 echoes as well");

        // Pre-first-request 200 keeps its echo after a runtime report.
        const prefirst = `prefirst-conversation-${process.pid}-${Date.now()}`;
        const runtime = await request(port, {
            path: "/__bili/plugin/runtime-info",
            method: "POST",
            headers: { host: trusted, origin: paneOrigin, "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", conversationId: prefirst }),
        });
        assert.equal(runtime.status, 200, "runtime-info accepted");
        const pre = await request(port, {
            path: `/__bili/plugin/status?conversationId=${encodeURIComponent(prefirst)}&fallback=latest`,
            headers: { host: trusted, origin: paneOrigin },
        });
        assert.equal(pre.status, 200);
        assert.equal(JSON.parse(pre.body).phase, "pre-first-request");
        assert.equal(pre.acao, paneOrigin, "ordinary pre-first-request path echoes too");

        // The gate still wins over CORS: a foreign origin never gets the echo.
        const spoofed = await request(port, {
            path: `/__bili/plugin/status?conversationId=${encodeURIComponent(fresh)}&fallback=latest`,
            headers: { host: trusted, origin: "http://evil.example:8080" },
        });
        assert.equal(spoofed.status, 403, "non-loopback Origin is refused before dispatch");
        assert.equal(spoofed.acao, undefined, "refused requests must not carry access-control-allow-origin");

        // Non-browser pollers (curl, CLI): nothing to echo.
        const curlLike = await request(port, {
            path: `/__bili/plugin/status?conversationId=${encodeURIComponent(fresh)}&fallback=latest`,
            headers: { host: trusted },
        });
        assert.equal(curlLike.status, 404);
        assert.equal(curlLike.acao, undefined, "no Origin header → no echo");
    });
});
