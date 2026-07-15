import test from "node:test";
import assert from "node:assert/strict";
import {
  beginShikigamiAction,
  canCounterCardAttack,
  hasSelectableAttackUnit,
  isSelectableAttackUnit,
  reduceUnitDamage,
} from "../dist/server/combat-rules.js";

test("Genki shell reduction persists across damage until its next action starts", () => {
  const unit = { nextDamageReduction: 0, shellDamageReduction: 2 };
  assert.equal(reduceUnitDamage(5, unit), 3);
  assert.equal(reduceUnitDamage(4, unit), 2);
  assert.equal(unit.shellDamageReduction, 2);

  beginShikigamiAction(unit);
  assert.equal(unit.shellDamageReduction, 0);
  assert.equal(reduceUnitDamage(4, unit), 4);
});

test("one-shot reduction is consumed without consuming shell reduction", () => {
  const unit = { nextDamageReduction: 1, shellDamageReduction: 2 };
  assert.equal(reduceUnitDamage(5, unit), 2);
  assert.equal(unit.nextDamageReduction, 0);
  assert.equal(unit.shellDamageReduction, 2);
  assert.equal(reduceUnitDamage(5, unit), 3);
});

test("card attack counter requires damage and two surviving participants", () => {
  assert.equal(canCounterCardAttack(true, 1, 30, ["反撃"]), true);
  assert.equal(canCounterCardAttack(false, 1, 30, ["反撃"]), false);
  assert.equal(canCounterCardAttack(true, 0, 30, ["反撃"]), false);
  assert.equal(canCounterCardAttack(true, 1, 0, ["反撃"]), false);
  assert.equal(canCounterCardAttack(true, 1, 30, []), false);
});

test("stealth and taunt determine selectable single-attack targets", () => {
  const stealth = { keywords: ["ステルス"] };
  const ordinary = { keywords: [] };
  assert.equal(isSelectableAttackUnit([stealth], stealth), false);
  assert.equal(hasSelectableAttackUnit([stealth]), false);
  assert.equal(isSelectableAttackUnit([stealth, ordinary], ordinary), true);

  const taunt = { keywords: ["挑発"] };
  assert.equal(isSelectableAttackUnit([ordinary, taunt], ordinary), false);
  assert.equal(isSelectableAttackUnit([ordinary, taunt], taunt), true);
  assert.equal(isSelectableAttackUnit([ordinary, taunt], ordinary, true), true);
});
