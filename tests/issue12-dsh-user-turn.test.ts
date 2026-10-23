import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dshUserTurnBoundary,
  durableMessageToolPaths,
  withDurableProtection,
} from "../src/durable-message-guards.js";
import { effectiveConfig, storeEffectiveConfig, type Session } from "../src/session.js";
import { defaultConfig } from "../kernel/src/config.js";
import type { CoreMessage } from "acp-kernel";

const user = (text: string): CoreMessage => ({
  id: text,
  role: "user",
  contentType: "text",
  text,
});

test("DSH machine envelopes do not replace the human boundary", () => {
  for (const text of [
    "Time sampled while preparing turn 3, step 12: 2026-10-23T17:00:00+08:00\nBrowser time zone for this request: Asia/Shanghai.",
    "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.",
    "\x3csystem-reminder\x3e\nInstructions from: AGENTS.md\nlocal instructions\n\x3c/system-reminder\x3e",
  ]) {
    assert.equal(dshUserTurnBoundary(user(text)), false);
  }
  for (const text of [
    "continue",
    "Explain Time sampled while preparing turn 1",
    "Please inspect Instructions from: notes",
    "Time sampled while preparing turn is a phrase",
    "\x3cavailable_skills\x3e quoted text",
  ]) {
    assert.equal(dshUserTurnBoundary(user(text)), true);
  }
});

test("boundary classifier is installed only on the DSH lane", () => {
  const base = defaultConfig(100000);
  assert.equal(
    withDurableProtection(base, durableMessageToolPaths.dsh!).isUserTurnBoundary,
    dshUserTurnBoundary,
  );
  assert.equal(withDurableProtection(base, () => undefined).isUserTurnBoundary, undefined);
  assert.equal(base.isUserTurnBoundary, undefined);
});

test("effective config restores classifier without persisting functions", () => {
  const base = defaultConfig(100000);
  const session = { metadata: { pluginAgent: "dsh", effectiveConfig: structuredClone(base) } } as Session;
  const before = structuredClone(session.metadata);
  const resolved = effectiveConfig(session, base);
  assert.equal(resolved.isUserTurnBoundary, dshUserTurnBoundary);
  assert.deepEqual(session.metadata, before);
  assert.equal(base.isUserTurnBoundary, undefined);

  storeEffectiveConfig(session, resolved);
  const stored = session.metadata.effectiveConfig as Record<string, unknown>;
  assert.equal(stored.isUserTurnBoundary, undefined);
  assert.equal(stored.messagePathOf, undefined);
  assert.doesNotThrow(() => structuredClone(session.metadata));
  assert.equal(effectiveConfig(session, base).isUserTurnBoundary, dshUserTurnBoundary);
});
