import test from "node:test";
import assert from "node:assert/strict";
import { perspectiveLog } from "../dist/server/perspective.js";

test("online battle logs are expressed from each player's perspective", () => {
  const hostLog = "プレイヤーが霊弾を使用し、CPUへ3ダメージ。";
  assert.equal(perspectiveLog(hostLog, "player"), "自分が霊弾を使用し、相手へ3ダメージ。");
  assert.equal(perspectiveLog(hostLog, "cpu"), "相手が霊弾を使用し、自分へ3ダメージ。");
});

test("shared player wording is not corrupted by perspective conversion", () => {
  assert.equal(perspectiveLog("清流により両プレイヤーのMPが1増加した。", "cpu"), "清流により両プレイヤーのMPが1増加した。");
});
