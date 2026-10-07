import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreWindowState } from "./window-state.mjs";

const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
test("restores valid window geometry and maximization", () => {
  const state = { x: 100, y: 50, width: 1000, height: 700, maximized: true };
  assert.deepEqual(restoreWindowState(state, displays), state);
});
test("recovers from corrupt state or a disconnected monitor", () => {
  for (const state of [
    null,
    {},
    { x: 4000, y: 0, width: 1200, height: 800 },
    { x: 0, y: -800, width: 1200, height: 800 },
    { x: 0, y: 0, width: -1, height: 800 },
  ]) {
    assert.deepEqual(restoreWindowState(state, displays), { width: 1280, height: 860, maximized: false });
  }
});
