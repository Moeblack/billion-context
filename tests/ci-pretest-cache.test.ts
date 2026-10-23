// Unit coverage for the pretest dist cache (scripts/ci-pretest-cache.mjs):
// hash determinism/invalidation, marker freshness in every stale shape, and
// the ensurePretestBuild skip path. The spawn-and-build path is exercised by
// CI itself on every cold leg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    computePretestHash,
    ensurePretestBuild,
    pretestBuildIsFresh,
    readPretestMarker,
    writePretestMarker,
} from "../scripts/ci-pretest-cache.mjs";

function makePkg() {
    const root = mkdtempSync(join(tmpdir(), "pretest-cache-"));
    const pkg = join(root, "kernel");
    mkdirSync(join(pkg, "src", "deep"), { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(pkg, "src", "deep", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(pkg, "package.json"), "{\n  \"name\": \"kernel\",\n  \"version\": \"0.0.1\"\n}\n");
    writeFileSync(join(pkg, "tsup.config.ts"), "export default {};\n");
    writeFileSync(join(pkg, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    return { root, pkg };
}

test("hash is deterministic and content+path sensitive", () => {
    const { root, pkg } = makePkg();
    try {
        const h1 = computePretestHash(pkg, root);
        assert.equal(computePretestHash(pkg, root), h1);

        writeFileSync(join(pkg, "src", "index.ts"), "export const a = 2;\n");
        assert.notEqual(computePretestHash(pkg, root), h1, "content change must invalidate");

        // Same bytes under a different path: rename invalidates.
        const root2 = makePkg();
        try {
            writeFileSync(join(root2.pkg, "src", "renamed.ts"), "export const a = 2;\n");
            rmSync(join(root2.pkg, "src", "index.ts"));
            assert.notEqual(computePretestHash(root2.pkg, root2.root), computePretestHash(pkg, root));
        } finally {
            rmSync(root2.root, { recursive: true, force: true });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("marker freshness: fresh only when marker version+hash match AND dist entry exists", () => {
    const { root, pkg } = makePkg();
    try {
        const hash = computePretestHash(pkg, root);
        assert.equal(readPretestMarker(pkg), null, "no marker yet");
        assert.equal(pretestBuildIsFresh(pkg, hash), false, "no marker -> stale");

        writeFileSync(join(pkg, "dist", "index.js"), "built\n");
        writePretestMarker(pkg, hash);
        assert.equal(pretestBuildIsFresh(pkg, hash), true, "marker + entry -> fresh");

        assert.equal(pretestBuildIsFresh(pkg, "deadbeef"), false, "hash mismatch -> stale");

        const markerPath = join(pkg, "dist", ".pretest-build.json");
        writeFileSync(markerPath, JSON.stringify({ v: 99, hash }));
        assert.equal(pretestBuildIsFresh(pkg, hash), false, "future marker version -> stale");

        writePretestMarker(pkg, hash);
        rmSync(join(pkg, "dist", "index.js"));
        assert.equal(pretestBuildIsFresh(pkg, hash), false, "missing dist/index.js -> stale");

        writeFileSync(markerPath, "{ not json");
        assert.equal(readPretestMarker(pkg), null, "malformed marker reads as absent");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("ensurePretestBuild skips the build when the marker matches (no spawn)", () => {
    const { root, pkg } = makePkg();
    try {
        const hash = computePretestHash(pkg, root);
        writeFileSync(join(pkg, "dist", "index.js"), "built\n");
        writePretestMarker(pkg, hash);
        // Fresh marker: returns without spawning npm (a spawn here would try to
        // build a fake package and fail loudly, so reaching the return at all
        // IS the skip-path proof).
        const res = ensurePretestBuild("kernel", { root });
        assert.equal(res.built, false);
        assert.equal(res.hash, hash);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
