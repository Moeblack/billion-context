import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { handleConfigGet, handleConfigPut } from "../src/web/api.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { translate } from "../src/web/i18n.ts";
import { rmrf } from "./tmp-rm.ts";

type Listener = (ev?: unknown) => void;
interface DomEl {
    tagName: string;
    innerHTML: string;
    textContent: string;
    value: string;
    hidden: boolean;
    disabled: boolean;
    className: string;
    style: Record<string, unknown>;
    dataset: Record<string, string>;
    children: unknown[];
    options: unknown[];
    parentElement: unknown;
    lastChild: unknown;
    classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
    addEventListener(type: string, fn: Listener): void;
    removeEventListener(): void;
    appendChild(child: unknown): unknown;
    prepend(child: unknown): unknown;
    append(...children: unknown[]): void;
    replaceChildren(...children: unknown[]): void;
    removeChild(child: unknown): unknown;
    insertBefore(child: unknown): unknown;
    remove(): void;
    focus(): void;
    click(): void;
    getAttribute(name: string): unknown;
    setAttribute(name: string, v: unknown): void;
    querySelector(): null;
    querySelectorAll(): never[];
    closest(): null;
    getContext(): null;
}

function makeDomStub(tag: string): DomEl {
    const listeners = new Map<string, Listener[]>();
    const el: DomEl = {
        tagName: tag.toUpperCase(),
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        disabled: false,
        className: "",
        style: {},
        dataset: {},
        children: [],
        options: [],
        parentElement: null,
        get lastChild() { return el.children[el.children.length - 1] ?? null; },
        classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
        addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
        removeEventListener() { },
        appendChild(child) { el.children.push(child); if (child && typeof child === "object") (child as { parentElement?: unknown }).parentElement = el; return child; },
        prepend(child) { el.children.unshift(child); if (child && typeof child === "object") (child as { parentElement?: unknown }).parentElement = el; return child; },
        append(...children) { for (const child of children) el.appendChild(child); },
        removeChild(child) { const at = el.children.indexOf(child); if (at >= 0) el.children.splice(at, 1); return child; },
        insertBefore(child) { el.children.push(child); if (child && typeof child === "object") (child as { parentElement?: unknown }).parentElement = el; return child; },
        replaceChildren(...children) { el.children.splice(0, el.children.length); for (const child of children) el.appendChild(child); },
        remove() { },
        focus() { },
        click() { for (const fn of [...(listeners.get("click") ?? [])]) void fn(); },
        getAttribute(name) { return (el as unknown as Record<string, unknown>)[name] ?? null; },
        setAttribute(name, v) { (el as unknown as Record<string, unknown>)[name] = String(v); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getContext() { return null; },
    };
    return el;
}

async function startConfigApi(): Promise<{ base: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/config") { void handleConfigGet(res); return; }
        if (req.method === "PUT" && req.url === "/__bili/config") { void handleConfigPut(req, res); return; }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1");
    if (!server.listening) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    return {
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function runConfigPage(base: string): Promise<Map<string, DomEl>> {
    const byId = new Map<string, DomEl>();
    const idEl = (id: string): DomEl => { let el = byId.get(id); if (!el) { el = makeDomStub("div"); byId.set(id, el); } return el; };
    const documentStub = {
        hidden: false,
        body: makeDomStub("body"),
        documentElement: makeDomStub("html"),
        getElementById: (id: string) => idEl(id),
        createElement: (tag: string) => makeDomStub(tag),
        createTextNode: (text: string) => ({ nodeType: 3, textContent: text, nodeValue: text }),
        createDocumentFragment: () => makeDomStub("fragment"),
        querySelectorAll: () => [] as unknown[],
        querySelector: () => null,
        addEventListener() { },
        removeEventListener() { },
        execCommand() { return true; },
    };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout, clearTimeout, clearInterval,
        setInterval: () => 0,
        fetch: (url: string, opts?: RequestInit) => fetch(new URL(url, base), opts),
        document: documentStub,
        window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
        location: { hash: "#/config" },
        navigator: { language: "en-US" },
        localStorage: { getItem: () => null, setItem() { } },
    };
    vm.createContext(sandbox);
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    return byId;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
}

interface Scenario {
    configFile: string;
    env: string | undefined;
    body: string;
    apiBase: string;
}

async function withScenarios(fn: (sc: Scenario, els: Map<string, DomEl>) => Promise<void>, scenario: { passthrough?: boolean; env?: "1" | "0" }): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-web-passthrough-"));
    const configFile = path.join(root, "billion-context.json");
    const fileBody = scenario.passthrough ? JSON.stringify({ passthrough: true }, null, 2) + "\n" : "";
    if (scenario.passthrough) writeFileSync(configFile, fileBody, "utf8");
    const prevConfigEnv = process.env.BILI_CONFIG_FILE;
    const prevPassthroughEnv = process.env.ACP_PASSTHROUGH;
    process.env.BILI_CONFIG_FILE = configFile;
    if (scenario.env === undefined) delete process.env.ACP_PASSTHROUGH;
    else process.env.ACP_PASSTHROUGH = scenario.env;
    const api = await startConfigApi();
    try {
        const els = await runConfigPage(api.base);
        await waitFor(() => els.get("pt-state")?.textContent === "On" || els.get("pt-state")?.textContent === "Off", `passthrough state never rendered; toasts=${JSON.stringify((els.get("toast-host")?.children ?? []).map((c) => (c as { textContent?: string }).textContent))}`);
        await fn({ configFile, env: scenario.env, body: fileBody, apiBase: api.base }, els);
    } finally {
        await api.close();
        if (prevConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfigEnv;
        if (prevPassthroughEnv === undefined) delete process.env.ACP_PASSTHROUGH; else process.env.ACP_PASSTHROUGH = prevPassthroughEnv;
        rmrf(root);
    }
}

// #1426: the clear button exists for file-sourced passthrough only. An
// ACP_PASSTHROUGH env (or --passthrough) outranks the file, and the PUT
// endpoint refuses such writes with 409 — so the button must be HIDDEN when
// env owns the state and VISIBLE when the file does.
test("web passthrough: file-sourced enabled offers the clear button", async () => {
    await withScenarios(async (sc, els) => {
        assert.equal(els.get("pt-state")!.textContent, translate("en", "cfg.pt_on"));
        assert.equal(els.get("pt-source")!.textContent, translate("en", "sys.pt_file"));
        assert.equal(els.get("clear-passthrough")!.hidden, false, "file-sourced passthrough must be clearable from the panel");
        // Positive direction: the button actually clears the file.
        els.get("clear-passthrough")!.click();
        await waitFor(() => !readFileSync(sc.configFile, "utf8").includes("passthrough"), "clear did not remove passthrough from the config file");
        await waitFor(() => els.get("pt-state")!.textContent === translate("en", "cfg.pt_off"), "panel did not re-render as disabled after clearing");
        assert.equal(els.get("clear-passthrough")!.hidden, true, "button hides once nothing is enabled");
    }, { passthrough: true });
});

test("web passthrough: env-sourced enabled hides the clear button the API would refuse", async () => {
    await withScenarios(async (sc, els) => {
        assert.equal(els.get("pt-state")!.textContent, translate("en", "cfg.pt_on"));
        assert.equal(els.get("pt-source")!.textContent, translate("en", "sys.pt_env"));
        assert.equal(els.get("clear-passthrough")!.hidden, true, "env-forced passthrough cannot be cleared here — PUT answers 409");
        assert.equal(existsSync(sc.configFile), false, "no config file exists to clear");
        const refused = await fetch(`${sc.apiBase}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: null }),
        });
        assert.equal(refused.status, 409, "the hidden button mirrors the API's refusal — leaving it visible would be a dead control");
        assert.match(String((await refused.json() as { error?: string }).error), /ACP_PASSTHROUGH/);
    }, { env: "1" });
});

test("web passthrough: disabled hides the clear button", async () => {
    await withScenarios(async (sc, els) => {
        assert.equal(els.get("pt-state")!.textContent, translate("en", "cfg.pt_off"));
        assert.equal(els.get("pt-source")!.textContent, "");
        assert.equal(els.get("clear-passthrough")!.hidden, true);
        assert.equal(existsSync(sc.configFile), false);
    }, {});
});

test("web passthrough: env forcing it off still hides the clear button (PUT stays refused)", async () => {
    await withScenarios(async (sc, els) => {
        assert.equal(els.get("pt-state")!.textContent, translate("en", "cfg.pt_off"));
        assert.equal(els.get("pt-source")!.textContent, translate("en", "sys.pt_env"));
        assert.equal(els.get("clear-passthrough")!.hidden, true, "an env-forced off state cannot be cleared by deleting a file key");
        assert.ok(readFileSync(sc.configFile, "utf8").includes('"passthrough": true'), "file still carries the inert passthrough value");
        const refused = await fetch(`${sc.apiBase}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: null }),
        });
        assert.equal(refused.status, 409, "env=0 also owns the state — clearing here is refused too");
    }, { passthrough: true, env: "0" });
});
