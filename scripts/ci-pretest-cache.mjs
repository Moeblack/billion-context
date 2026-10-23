// Content-hash cache gate for the pretest dist builds (kernel/, pi-subagents/).
//
// Why: every CI test leg rebuilt both bundles from scratch (~6 min of the
// Windows wall). The bundles are deterministic pure-JavaScript output keyed
// only by their source tree + build config, so a dist that matches a hash of
// exactly those inputs is as good as a fresh build. The workflow layer
// (actions/cache) may restore a stale or foreign dist — correctness never
// depends on it: the marker recorded inside dist/ is re-verified against the
// LIVE source hash, and any mismatch falls back to a real build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PRETEST_MARKER_VERSION = 1;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_CONFIG_FILES = ["package.json", "tsup.config.ts", "tsconfig.json"];

function listSourceFiles(dir, acc) {
    if (!existsSync(dir)) return acc;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) listSourceFiles(p, acc);
        else if (ent.isFile()) acc.push(p);
    }
    return acc;
}

// Deterministic content hash over the package's src/** plus its build config
// files plus the repo package-lock.json (toolchain pins: tsup/esbuild/tsx
// versions come from the root lock). File identity = path relative to the
// package dir, so renames invalidate.
export function computePretestHash(pkgDir, repoRoot) {
    const files = [
        ...listSourceFiles(join(pkgDir, "src"), []),
        ...PKG_CONFIG_FILES.map((f) => join(pkgDir, f)),
        join(repoRoot, "package-lock.json"),
    ].filter((f) => existsSync(f));
    files.sort();
    const h = createHash("sha256");
    for (const f of files) {
        h.update(f.slice(pkgDir.length + 1));
        h.update("\0");
        h.update(readFileSync(f));
        h.update("\0");
    }
    return h.digest("hex");
}

export function readPretestMarker(pkgDir) {
    try {
        const raw = JSON.parse(readFileSync(join(pkgDir, "dist", ".pretest-build.json"), "utf8"));
        if (typeof raw?.v === "number" && typeof raw?.hash === "string") return raw;
    } catch {
        // absent or malformed marker = stale dist; rebuild.
    }
    return null;
}

export function writePretestMarker(pkgDir, hash) {
    const dist = join(pkgDir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
        join(dist, ".pretest-build.json"),
        JSON.stringify({ v: PRETEST_MARKER_VERSION, hash }, null, 2) + "\n",
    );
}

// Fresh = marker matches the live source hash AND the dist entry the suites
// import actually exists. A restored-but-stale cache fails the first check; a
// half-written restore fails the second.
export function pretestBuildIsFresh(pkgDir, expectedHash) {
    const marker = readPretestMarker(pkgDir);
    return (
        marker !== null &&
        marker.v === PRETEST_MARKER_VERSION &&
        marker.hash === expectedHash &&
        existsSync(join(pkgDir, "dist", "index.js"))
    );
}

// Build one package unless its dist already matches the source hash. npm on
// Windows is a .cmd batch file, which CreateProcess cannot exec directly
// (EINVAL) — route through cmd.exe via shell:true; the args are fixed
// literals, so there is no quoting surface (same contract as run-ci-tests).
export function ensurePretestBuild(pkgName, opts = {}) {
    const pkgDir = join(opts.root ?? ROOT, pkgName);
    const hash = computePretestHash(pkgDir, opts.root ?? ROOT);
    if (pretestBuildIsFresh(pkgDir, hash)) {
        console.log(`[pretest-cache] ${pkgName}: dist matches source (hash ${hash.slice(0, 12)}) — build skipped`);
        return { built: false, hash };
    }
    console.log(`[pretest-cache] ${pkgName}: dist stale or absent (hash ${hash.slice(0, 12)}) — building`);
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npmCmd, ["--prefix", pkgName, "run", "build"], {
        cwd: opts.root ?? ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
    });
    if (!existsSync(join(pkgDir, "dist", "index.js"))) {
        throw new Error(`[pretest-cache] ${pkgName}: build reported success but dist/index.js is missing`);
    }
    writePretestMarker(pkgDir, hash);
    return { built: true, hash };
}

if (process.argv[1] && process.argv[1].endsWith("ci-pretest-cache.mjs") && process.argv.length > 2) {
    for (const pkg of process.argv.slice(2)) ensurePretestBuild(pkg);
}
