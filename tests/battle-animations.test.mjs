import test from "node:test";
import assert from "node:assert/strict";
import { deriveBattleVisualChanges } from "../dist/client/battle-animations.js";

const unit = (instanceId, hp = 5) => ({
  instanceId, shikigamiId: `master_${instanceId}`, name: instanceId, attribute: "木",
  hp, maxHp: 5, attack: 1, aiProfile: "random", keywords: [], ability: "",
  curses: [], nextDamageReduction: 0, shellDamageReduction: 0, nextAttackBonus: 0,
});
const player = (hp, shikigami = []) => ({ hp, mp: 0, cost: 5, curses: [], nextDamageReduction: 0, shikigami, retiredShikigami: [] });
const battleState = ({ turn = 1, active = "player", playerHp = 30, cpuHp = 30, playerUnits = [], cpuUnits = [], log = [] } = {}) => ({
  phase: "battle", mode: "cpu", battle: {
    turnNumber: turn, activePlayer: active, phase: "card_use",
    player: { ...player(playerHp, playerUnits), hand: [], discard: [] },
    cpu: { ...player(cpuHp, cpuUnits), handCount: 5 }, log,
  },
});

test("battle animation changes describe turn, damage, summon, and retirement", () => {
  const previous = battleState({ playerUnits: [unit("old")], cpuUnits: [unit("enemy", 5)] });
  const next = battleState({
    turn: 2, playerHp: 27, playerUnits: [unit("new")], cpuUnits: [unit("enemy", 3)],
    log: ["CPUが霊符術：霊弾を使用した。"],
  });
  const changes = deriveBattleVisualChanges(previous, next);
  assert.ok(changes.some((change) => change.type === "turn" && change.turnNumber === 2));
  assert.ok(changes.some((change) => change.type === "damage" && change.side === "player" && change.amount === 3));
  assert.ok(changes.some((change) => change.type === "damage" && change.unitId === "enemy" && change.amount === 2));
  assert.ok(changes.some((change) => change.type === "retire" && change.unitId === "old"));
  assert.ok(changes.some((change) => change.type === "summon" && change.unitId === "new"));
  assert.ok(changes.some((change) => change.type === "action" && change.side === "cpu"));
});

test("entering battle produces a battle-start cue", () => {
  const changes = deriveBattleVisualChanges({ phase: "attribute_reveal" }, battleState());
  assert.deepEqual(changes, [{ type: "battle_start", side: "player" }]);
});
