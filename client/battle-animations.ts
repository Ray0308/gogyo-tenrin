import type { SessionState, ShikigamiState } from "../shared/protocol.js";

export type BattleSide = "player" | "cpu";
export type BattleVisualChange =
  | { type: "battle_start"; side: BattleSide }
  | { type: "turn"; side: BattleSide; turnNumber: number }
  | { type: "damage" | "heal"; side: BattleSide; amount: number; unitId?: string }
  | { type: "summon" | "retire"; side: BattleSide; unitId: string; name: string }
  | { type: "action"; side: BattleSide; text: string };

function unitChanges(
  previous: ShikigamiState[],
  next: ShikigamiState[],
  side: BattleSide,
): BattleVisualChange[] {
  const changes: BattleVisualChange[] = [];
  const previousById = new Map(previous.map((unit) => [unit.instanceId, unit]));
  const nextById = new Map(next.map((unit) => [unit.instanceId, unit]));

  for (const unit of next) {
    const oldUnit = previousById.get(unit.instanceId);
    if (!oldUnit) {
      changes.push({ type: "summon", side, unitId: unit.instanceId, name: unit.name });
      continue;
    }
    const hpDifference = unit.hp - oldUnit.hp;
    if (hpDifference < 0) changes.push({ type: "damage", side, unitId: unit.instanceId, amount: -hpDifference });
    if (hpDifference > 0) changes.push({ type: "heal", side, unitId: unit.instanceId, amount: hpDifference });
  }
  for (const unit of previous) {
    if (!nextById.has(unit.instanceId)) changes.push({ type: "retire", side, unitId: unit.instanceId, name: unit.name });
  }
  return changes;
}

function actionSide(text: string): BattleSide {
  return /CPU|相手/.test(text) ? "cpu" : "player";
}

export function deriveBattleVisualChanges(previous: SessionState, next: SessionState): BattleVisualChange[] {
  const nextBattle = next.battle;
  if (next.phase !== "battle" || !nextBattle) return [];
  const previousBattle = previous.phase === "battle" ? previous.battle : undefined;
  if (!previousBattle) return [{ type: "battle_start", side: nextBattle.activePlayer }];

  const changes: BattleVisualChange[] = [];
  const turnChanged = previousBattle.turnNumber !== nextBattle.turnNumber || previousBattle.activePlayer !== nextBattle.activePlayer;

  for (const side of ["player", "cpu"] as const) {
    const hpDifference = nextBattle[side].hp - previousBattle[side].hp;
    if (hpDifference < 0) changes.push({ type: "damage", side, amount: -hpDifference });
    if (hpDifference > 0) changes.push({ type: "heal", side, amount: hpDifference });
    changes.push(...unitChanges(previousBattle[side].shikigami, nextBattle[side].shikigami, side));
  }

  const addedLogs = nextBattle.log.slice(previousBattle.log.length);
  const actionLogs = addedLogs.filter((entry) => /CPU.*(?:使用|攻撃)|countered/.test(entry)).slice(-2);
  for (const text of actionLogs) changes.push({ type: "action", side: actionSide(text), text });
  if (turnChanged) changes.push({ type: "turn", side: nextBattle.activePlayer, turnNumber: nextBattle.turnNumber });
  return changes;
}
