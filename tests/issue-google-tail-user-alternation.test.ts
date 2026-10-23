// Pins two host-side tail appends that bypassed coreToGoogle's role merging
// and produced a repeated `user` role on the Gemini wire:
//   - src/loop/adapter-google.ts buildRequest (system-anchor notes on the
//     round-2 re-request, whose tail is the compress call + its result);
//   - src/server/prepare-google.ts (the #2228 decision side body).
// Both route through appendGoogleUserText now.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { GoogleContent, GooglePart } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { pickAdapter } from "../src/loop/index.ts";
import { appendGoogleUserText } from "../src/wire-body.ts";

type Part = { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean; thoughtSignature?: string };

function partsOf(content: GoogleContent): Part[] {
    return Array.isArray(content.parts) ? (content.parts as Part[]) : [];
}

function roleRepeats(contents: GoogleContent[]): string[] {
    const problems: string[] = [];
    for (let i = 1; i < contents.length; i++) {
        if ((contents[i]!.role ?? "user") === (contents[i - 1]!.role ?? "user")) {
            problems.push(`content[${i}] repeats role ${contents[i]!.role ?? "user"}`);
        }
    }
    return problems;
}

test("appendGoogleUserText merges into a user tail and never mutates its input", () => {
    const tail: GoogleContent = { role: "user", parts: [{ text: "done" }] };
    const input: GoogleContent[] = [{ role: "model", parts: [{ text: "hi" }] }, tail];
    const out = appendGoogleUserText(input, "note");

    assert.equal(out.length, 2, "no new content — merged into the tail");
    assert.deepEqual(out[1]!.parts, [{ text: "done" }, { text: "note" }]);
    assert.equal(input[1], tail, "input array untouched");
    assert.deepEqual(partsOf(tail), [{ text: "done" }], "input tail's parts array untouched");
    assert.notEqual(out[1], tail, "merged tail is a fresh object");
});

test("appendGoogleUserText treats an absent role as user", () => {
    const input: GoogleContent[] = [{ parts: [{ text: "q" }] }];
    const out = appendGoogleUserText(input, "note");
    assert.equal(out.length, 1, "a role-less trailing content merges like a user turn");
    assert.deepEqual(out[0]!.parts, [{ text: "q" }, { text: "note" }]);
});

test("appendGoogleUserText opens a new user content only after a model turn", () => {
    const out = appendGoogleUserText([{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ text: "a" }] }], "note");
    assert.deepEqual(out.map((c) => c.role), ["user", "model", "user"]);
    assert.deepEqual(out[2]!.parts, [{ text: "note" }]);
    assert.deepEqual(roleRepeats(out), [], "roles still alternate");
});

test("appendGoogleUserText keeps note order across successive appends", () => {
    let contents: GoogleContent[] = [{ role: "user", parts: [{ text: "q" }] }];
    for (const note of ["first", "second", "third"]) contents = appendGoogleUserText(contents, note);
    assert.equal(contents.length, 1, "all notes land on the same trailing content");
    assert.deepEqual(partsOf(contents[0]!).map((p) => p.text), ["q", "first", "second", "third"]);
});

test("appendGoogleUserText preserves signed parts by identity and keeps functionResponse last (#3159)", () => {
    const signed: GooglePart = { text: "signed prose", thoughtSignature: "sig-1" };
    const out = appendGoogleUserText([{ role: "user", parts: [{ functionResponse: { name: "compress", response: { ok: true } } }, signed] }], "note");
    const parts = partsOf(out[0]!);

    assert.equal(parts[0]!.text, "note", "the appended text leads the functionResponse");
    assert.equal(parts[1]!.functionResponse !== undefined, true, "functionResponse follows the plain text");
    assert.equal(parts[2], signed, "the signed part is the very same object, byte-identical");
    assert.equal(parts[2]!.thoughtSignature, "sig-1");
});

function loopAdapter(notes: string[]) {
    return pickAdapter("google", { contents: [], model: "gemini-test" }, false, undefined, undefined, undefined, undefined, { system: "you are a test assistant", model: "gemini-test" }, notes);
}

const NOTE = "[System context update] The ambient instructions in the system prompt changed during this conversation.";

test("google round-2 re-request: system notes merge into the trailing tool-result turn (F1)", () => {
    const coreMessages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "please compress" },
        { id: "a1", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c1", text: '{"content":[]}' },
        { id: "t1", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "c1", text: "compressed" },
    ];

    const body = loopAdapter([NOTE]).buildRequest(coreMessages, "compress prompt", { contents: [], model: "gemini-test" }) as { contents: GoogleContent[] };

    assert.deepEqual(roleRepeats(body.contents), [], `roles must alternate, got ${JSON.stringify(body.contents.map((c) => c.role))}`);
    assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user"], "the note rides the tool-result turn");

    const tail = partsOf(body.contents[body.contents.length - 1]!);
    const texts = tail.map((p) => p.text).filter((t): t is string => typeof t === "string");
    assert.equal(texts.filter((t) => t.includes(NOTE)).length, 1, "the note is delivered exactly once");
    assert.ok(tail.some((p) => p.functionResponse !== undefined), "the tool result still answers the compress call");
});

test("google round-2 re-request control: a model-side tail still gets its own user note content", () => {
    const coreMessages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "please compress" },
        { id: "a1", role: "assistant", contentType: "text", text: "all done" },
    ];
    const body = loopAdapter([NOTE]).buildRequest(coreMessages, "compress prompt", { contents: [] }) as { contents: GoogleContent[] };
    assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user"], "a new user turn after the model turn");
    assert.deepEqual(roleRepeats(body.contents), []);
});

test("google round-2 re-request control: no notes → coreToGoogle's own merge is the only shaping", () => {
    const coreMessages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "please compress" },
        { id: "t1", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "c1", text: "compressed" },
    ];
    const body = loopAdapter([]).buildRequest(coreMessages, "compress prompt", { contents: [] }) as { contents: GoogleContent[] };
    assert.deepEqual(body.contents.map((c) => c.role), ["user"], "control: coreToGoogle merges the tool result onto the user side");
    assert.ok(!JSON.stringify(body.contents).includes(NOTE), "control: no note without notes");
});

// ---------------------------------------------------------------------------
// Relay twins: the mock upstream rejects a repeated role, so a bad body fails
// the request instead of quietly succeeding.
// ---------------------------------------------------------------------------

const MODEL = "gemini-decide";

type DecideRig = {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    sideBodies: { contents: GoogleContent[]; violations: string[] }[];
    mainBodies: string[];
};

function googleJson(text: string, promptTokens: number): string {
    return JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
        modelVersion: "gemini-test",
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 3, totalTokenCount: promptTokens + 3 },
    });
}

function baseOptions(): Omit<ProxyOptions, "routes" | "compress"> {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
}

async function startDecideRig(): Promise<DecideRig> {
    const rig = { sideBodies: [] as DecideRig["sideBodies"], mainBodies: [] as string[] } as DecideRig;

    rig.upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as { contents?: GoogleContent[]; generationConfig?: { maxOutputTokens?: number } };
            const contents = Array.isArray(parsed.contents) ? parsed.contents : [];
            const maxOut = parsed.generationConfig?.maxOutputTokens;
            if (typeof maxOut === "number" && maxOut <= 200) {
                const violations = roleRepeats(contents);
                rig.sideBodies.push({ contents, violations });
                if (violations.length > 0) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "consecutive user turns are not allowed" } }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(googleJson('{"compress": true}', 50_000));
                return;
            }
            rig.mainBodies.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(googleJson("ok", 50_000));
        });
    });
    rig.upstream.listen(0, "127.0.0.1");
    await once(rig.upstream, "listening");
    rig.upstreamPort = (rig.upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    rig.proxy = await startServer({
        ...baseOptions(),
        routes: { [`http://127.0.0.1:${rig.upstreamPort}`]: { models: { [MODEL]: { context: 64_000 } } } },
        compress: { injectTool: true, injectNudge: true, nudgeModelDecided: true },
    });
    await once(rig.proxy, "listening");
    rig.proxyPort = (rig.proxy.address() as { port: number }).port;
    return rig;
}

async function closeDecideRig(rig: DecideRig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

// 50k reported input against a 64k route window = 78%: the OVER-LIMIT tier-1
// arm, which is the one that routes through the model-decided path.
function googleHistory(): GoogleContent[] {
    const filler = "y".repeat(20_000);
    const out: GoogleContent[] = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "ok" }] },
        { role: "user", parts: [{ text: "continue" }] },
        { role: "model", parts: [{ text: filler }] },
    ];
    for (let i = 1; i <= 12; i++) {
        out.push({ role: "user", parts: [{ text: `q${i} ` + "f".repeat(997) }] });
        out.push({ role: "model", parts: [{ text: `a${i} ` + "e".repeat(997) }] });
    }
    out.push({ role: "user", parts: [{ text: "now summarize" }] });
    return out;
}

test("google #2228 decide side body alternates roles (F2)", async () => {
    const rig = await startDecideRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/${MODEL}:generateContent`;
        const headers = { "content-type": "application/json", "x-acp-session": "decide-google" };

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: googleHistory(), generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.deepEqual(rig.sideBodies.flatMap((s) => s.violations), [], `side body must alternate, got ${JSON.stringify(rig.sideBodies[0]?.contents.map((c) => c.role))}`);
        assert.equal(rig.sideBodies.length, 1, "exactly one decision side call reached the upstream");
        assert.ok(
            JSON.stringify(rig.sideBodies[0]!.contents.at(-1)).includes("[bili-compress-decision]"),
            "the decision question rides the trailing user turn",
        );
        const main = rig.mainBodies.at(-1) ?? "";
        assert.ok(main.includes("[bili-compress-directive]"), "a yes verdict injects the directive (the side call was not rejected)");
    } finally {
        await closeDecideRig(rig);
    }
});

const NOTE_PREFIX = "[System context update]";
const BASE_SYSTEM = ["you are a test assistant", "Policy: be terse.", "Workspace: /tmp/demo", "Tools: none", "Style: plain", "Mode: strict"].join("\n");
const BASE_SYSTEM_EDITED = BASE_SYSTEM.replace("Style: plain", "Style: verbose");
const FOLD_TEXT = "folded middle segment: the conversation grew while the proxy compressed it";

function googleFrame(parts: Part[], finishReason?: string, usage?: Record<string, number>): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    const frame: Record<string, unknown> = { candidates: [candidate], modelVersion: "gemini-test" };
    if (usage) frame.usageMetadata = usage;
    return `data: ${JSON.stringify(frame)}\n\n`;
}

const USAGE = { promptTokenCount: 5000, cachedContentTokenCount: 0, candidatesContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 5050 };

function refIdsOf(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

type NotesRig = {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    violations: string[];
    compressCalls: number;
};

function userTurnText(i: number): string {
    return `user turn ${i}: ` + "the quick brown fox jumps over the lazy dog. ".repeat(80);
}

async function startNotesRig(): Promise<NotesRig> {
    const rig = { bodies: [] as string[], violations: [] as string[], compressCalls: 0 } as NotesRig;
    rig.upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            rig.bodies.push(body);
            try {
                const parsed = JSON.parse(body) as { contents?: GoogleContent[] };
                rig.violations.push(...roleRepeats(Array.isArray(parsed.contents) ? parsed.contents : []).map((v) => `req ${rig.bodies.length}: ${v}`));
            } catch {
                rig.violations.push(`req ${rig.bodies.length}: body is not JSON`);
            }

            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const ids = refIdsOf(body);
            if (!body.includes(FOLD_TEXT) && ids.length >= 6) {
                rig.compressCalls++;
                res.write(googleFrame([{ functionCall: { id: `fc_${rig.compressCalls}`, name: "compress", args: { content: [{ startId: ids[1]!, endId: ids[ids.length - 3]!, topic: "notes alternation", summary: FOLD_TEXT }] } } }]));
                res.write(googleFrame([], "STOP", USAGE));
            } else {
                res.write(googleFrame([{ text: `assistant reply ${rig.bodies.length}` }]));
                res.write(googleFrame([], "STOP", USAGE));
            }
            res.end();
        });
    });
    rig.upstream.listen(0, "127.0.0.1");
    await once(rig.upstream, "listening");
    rig.upstreamPort = (rig.upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    rig.proxy = await startServer({
        ...baseOptions(),
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, { preserveRecentMessages: 2, preserveRecentTokens: 600, compress: { minCompressRange: 800, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        routes: { [`http://127.0.0.1:${rig.upstreamPort}`]: { models: { "gemini-test": { context: 1_000_000 } } } },
        compress: { injectTool: true, injectNudge: true },
        stableSystemAnchor: true,
    });
    await once(rig.proxy, "listening");
    rig.proxyPort = (rig.proxy.address() as { port: number }).port;
    return rig;
}

async function closeNotesRig(rig: NotesRig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("google relay: system-anchor notes never open a second user turn on the compress re-request (F1)", async () => {
    const rig = await startNotesRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;
        const headers = { "content-type": "application/json", "x-acp-session": "notes-alternation" };
        const contents: GoogleContent[] = [];
        for (let i = 1; i <= 10; i++) {
            contents.push({ role: "user", parts: [{ text: userTurnText(i) }] });
            // Turn 3 edits one line of a multi-line systemInstruction: the
            // localized-change shape that arms anchor notes.
            const system = i >= 3 ? BASE_SYSTEM_EDITED : BASE_SYSTEM;
            const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: 4096 } }),
            });
            assert.equal(res.status, 200, `turn ${i}: HTTP ${res.status}`);
            let raw = "";
            for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
            assert.ok(!raw.includes("Compression FAILED"), `turn ${i}: compression must not fail`);
            const text = raw
                .split("\n\n")
                .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
                .filter((l): l is string => typeof l === "string")
                .map((l) => JSON.parse(l.slice(5).trim()) as { candidates?: { content?: { parts?: Part[] } }[] })
                .flatMap((ev) => (ev.candidates ?? []).flatMap((c) => (c.content?.parts ?? []).map((p) => p.text ?? "")))
                .join("");
            contents.push({ role: "model", parts: [{ text }] });
        }

        assert.deepEqual(rig.violations, [], `every rebuilt body must alternate roles: ${rig.violations.slice(0, 4).join(" | ")}`);
        assert.ok(rig.bodies.some((b) => b.includes(NOTE_PREFIX)), "the localized head edit must arm a note");
        assert.ok(rig.bodies.some((b) => b.includes(FOLD_TEXT)), "a compress cycle must fold a block");
        assert.ok(
            rig.bodies.some((b) => b.includes(NOTE_PREFIX) && b.includes('"functionResponse"')),
            "the notes must ride the round that answers the compress call (the F1 site)",
        );
    } finally {
        await closeNotesRig(rig);
    }
});
