import test from "node:test";
import assert from "node:assert/strict";
import { deriveBattleVisualChanges } from "../dist/client/battle-animations.js";

const unit = (instanceId, hp = 5) => ({
  instanceId, shikigamiId: `master_${instanceId}`, name: instanceId, attribute: "木",
  imageId: `image_${instanceId}`,
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
    log: ["CPUが霊符術：霊弾を使用し、プレイヤーへ3ダメージ。"],
  });
  const changes = deriveBattleVisualChanges(previous, next);
  assert.ok(changes.some((change) => change.type === "turn" && change.turnNumber === 2));
  assert.ok(changes.some((change) => change.type === "damage" && change.side === "player" && change.amount === 3));
  assert.ok(changes.some((change) => change.type === "damage" && change.unitId === "enemy" && change.amount === 2));
  assert.ok(changes.some((change) => change.type === "retire" && change.unitId === "old" && change.imageId === "image_old"));
  assert.ok(changes.some((change) => change.type === "summon" && change.unitId === "new"));
  assert.ok(changes.some((change) => change.type === "action" && change.side === "cpu"));
  assert.ok(changes.some((change) => change.type === "action" && change.kind === "attack"));
});

test("battle animation changes distinguish defense and counter actions", () => {
  const previous = battleState({
    playerUnits: [unit("白猿")],
    log: ["反応受付を開始した。"],
  });
  previous.battle.phase = "reaction";
  const next = battleState({
    playerUnits: [unit("白猿")],
    log: [
      "反応受付を開始した。",
      "プレイヤーが防御札 霊符術：守符を使用した。",
      "白猿の反撃により敵へ1ダメージ。",
    ],
  });
  const changes = deriveBattleVisualChanges(previous, next);
  assert.ok(changes.some((change) => change.type === "action" && change.kind === "defense"));
  assert.ok(changes.some((change) => change.type === "action" && change.kind === "counter" && change.actorUnitId === "白猿"));
});

test("entering battle produces a battle-start cue", () => {
  const changes = deriveBattleVisualChanges({ phase: "attribute_reveal" }, battleState());
  assert.deepEqual(changes, [{ type: "battle_start", side: "player" }]);
});

test("single-target attack animation identifies its damaged shikigami", () => {
  const previous = battleState({ cpuUnits: [unit("target", 5)] });
  const next = battleState({
    cpuUnits: [unit("target", 2)],
    log: ["プレイヤーが霊符術：霊弾を使用し、targetへ3ダメージ。"],
  });
  const attack = deriveBattleVisualChanges(previous, next).find(
    (change) => change.type === "action" && change.text.includes("霊弾"),
  );
  assert.equal(attack?.targetUnitId, "target");
});

test("online perspective labels identify self and opponent actions", () => {
  const previous = battleState();
  const selfAction = battleState({ cpuHp: 27, log: ["自分が霊符術：霊弾を使用し、相手へ3ダメージ。"] });
  const opponentAction = battleState({ playerHp: 27, log: ["相手が霊符術：霊弾を使用し、自分へ3ダメージ。"] });
  assert.ok(deriveBattleVisualChanges(previous, selfAction).some((change) => change.type === "action" && change.side === "player"));
  assert.ok(deriveBattleVisualChanges(previous, opponentAction).some((change) => change.type === "action" && change.side === "cpu"));
});

test("utility cards expose their system for a generic card animation", () => {
  const previous = battleState();
  const next = battleState({ log: ["プレイヤーが占事略决：転輪を使用した。"] });
  const action = deriveBattleVisualChanges(previous, next).find((change) => change.type === "action");
  assert.equal(action?.kind, "effect");
  assert.equal(action?.system, "占事略决");
});

test("only explicit defense-card logs use the defense animation", () => {
  const previous = battleState();
  const defense = battleState({ log: ["CPUが防御札 霊符術：守符を使用した。"] });
  const utility = battleState({ log: ["CPUが陰陽秘術：浄化を使用した。"] });
  assert.ok(deriveBattleVisualChanges(previous, defense).some((change) => change.type === "action" && change.kind === "defense"));
  assert.ok(deriveBattleVisualChanges(previous, utility).some((change) => change.type === "action" && change.kind === "effect"));
});
