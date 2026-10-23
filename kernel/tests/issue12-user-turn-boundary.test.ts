import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { computeProtectedRefs } from "../src/recommend.js";
import { coreToGoogle } from "../src/wire/google.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

const messages: BiliMessage[] = [
  { id: "old-user", role: "user", contentType: "text", text: "old task" },
  {
    id: "old-call", role: "assistant", contentType: "tool-call",
    toolName: "read", toolCallId: "old", text: "{}",
  },
  {
    id: "old-result", role: "tool", contentType: "tool-result",
    toolName: "read", toolCallId: "old", text: "old output",
  },
  { id: "before", role: "assistant", contentType: "text", text: "finished previous task" },
  { id: "human", role: "user", contentType: "text", text: "new task" },
  {
    id: "after", role: "assistant", contentType: "tool-call",
    toolName: "read", toolCallId: "new", text: "{}",
    googleThoughtSignature: "unchanged-signature",
  },
  {
    id: "new-result", role: "tool", contentType: "tool-result",
    toolName: "read", toolCallId: "new", text: "new output",
  },
  { id: "spent", role: "assistant", contentType: "text", text: "spent analysis ".repeat(300) },
  { id: "clock", role: "user", contentType: "text", text: "clock" },
];

function setup(enabled: boolean) {
  const config = defaultConfig(100000);
  config.preserveRecentMessages = 1;
  config.preserveRecentTokens = 0;
  config.compress.minCompressRange = 1;
  config.compress.minSummaryLength = 1;
  if (enabled) config.isUserTurnBoundary = (m) => m.id !== "clock";
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { config, state };
}

test("opt-in protects genuine user and both wire separators, not spent history", () => {
  const { config, state } = setup(true);
  const refs = computeProtectedRefs(messages, state, config);
  for (const id of ["human", "before", "after", "new-result"]) {
    assert.ok(refs.has(state.messageRefs.byRaw[id]!), id);
  }
  for (const id of ["old-user", "old-call", "old-result", "spent"]) {
    assert.ok(!refs.has(state.messageRefs.byRaw[id]!), id);
  }
  const plain = setup(false);
  assert.ok(!computeProtectedRefs(messages, plain.state, plain.config).has(plain.state.messageRefs.byRaw.human!));
});

test("real compression retains pure user boundary and exact signed call", () => {
  const { config, state } = setup(true);
  const core = createCore();
  const applied = core.applyCompression({
    messages, state, config,
    ranges: [{
      startRef: state.messageRefs.byRaw["old-user"]!,
      endRef: state.messageRefs.byRaw.spent!,
      summary: "spent history",
    }],
  });
  assert.equal(applied.result.errors.length, 0, applied.result.errors.join(";"));
  const turn = core.processTurn({ messages, state: applied.state, config, renderTags: "none" });
  const contents = coreToGoogle(turn.messages);
  const human = contents.find((c) => c.parts.some((p) => p.text?.includes("new task")));
  assert.ok(human);
  assert.ok(!human.parts.some((p) => p.functionResponse));
  const signed = contents.flatMap((c) => c.parts).find((p) => p.functionCall?.id === "new");
  assert.equal(signed?.thoughtSignature, "unchanged-signature");
  assert.ok(applied.state.blocks.some((b) => b.effectiveMessageIds.includes("old-user")));
});

for (const id of ["before", "after"]) {
  test(`cannot fold boundary separator ${id} alone`, () => {
    const { config, state } = setup(true);
    const core = createCore();
    const ref = state.messageRefs.byRaw[id]!;
    const applied = core.applyCompression({
      messages, state, config,
      ranges: [{ startRef: ref, endRef: ref, summary: "separator" }],
    });
    assert.ok(
      applied.result.errors.length > 0 ||
      !applied.state.blocks.some((b) => b.effectiveMessageIds.includes(id)),
    );
  });
}
