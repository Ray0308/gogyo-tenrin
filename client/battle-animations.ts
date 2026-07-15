import type { SessionState, ShikigamiState } from "../shared/protocol.js";

export type BattleSide = "player" | "cpu";
export type BattleVisualChange =
  | { type: "battle_start"; side: BattleSide }
  | { type: "turn"; side: BattleSide; turnNumber: number }
  | { type: "damage" | "heal"; side: BattleSide; amount: number; unitId?: string }
  | { type: "summon" | "retire"; side: BattleSide; unitId: string; name: string }
  | {
      type: "action";
      side: BattleSide;
      text: string;
      kind: "attack" | "defense" | "counter" | "effect";
      actorUnitId?: string;
      targetUnitId?: string;
    };

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

function actionKind(text: string): "attack" | "defense" | "counter" | "effect" {
  if (/反撃|countered/.test(text)) return "counter";
  if (/^(?:プレイヤー|CPU)が.+を使用した。$/.test(text)) return "defense";
  if (/ダメージ|攻撃|使用し、/.test(text)) return "attack";
  return "effect";
}

function actionUnit(
  text: string,
  previousBattle: NonNullable<SessionState["battle"]>,
  nextBattle: NonNullable<SessionState["battle"]>,
): { side: BattleSide; instanceId: string } | undefined {
  for (const side of ["player", "cpu"] as const) {
    const units = [...previousBattle[side].shikigami, ...nextBattle[side].shikigami];
    const unit = units.find((item) => text.startsWith(`${item.name}が`) || text.startsWith(`${item.name}の反撃`));
    if (unit) return { side, instanceId: unit.instanceId };
  }
  return undefined;
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
  const actionLogs = addedLogs.filter((entry) =>
    /(?:プレイヤー|CPU)が.+を使用|.+が.+へ\d+ダメージ|反撃|countered/.test(entry),
  ).slice(-6);
  for (const text of actionLogs) {
    const unit = actionUnit(text, previousBattle, nextBattle);
    const side = unit?.side ?? actionSide(text);
    const targetSide = side === "player" ? "cpu" : "player";
    const previousTargets = new Map(previousBattle[targetSide].shikigami.map((item) => [item.instanceId, item]));
    const damagedTargets = nextBattle[targetSide].shikigami.filter((item) => {
      const previousTarget = previousTargets.get(item.instanceId);
      return previousTarget && item.hp < previousTarget.hp;
    });
    changes.push({
      type: "action",
      side,
      text,
      kind: actionKind(text),
      actorUnitId: unit?.instanceId,
      targetUnitId: damagedTargets.length === 1 ? damagedTargets[0].instanceId : undefined,
    });
  }
  if (turnChanged) changes.push({ type: "turn", side: nextBattle.activePlayer, turnNumber: nextBattle.turnNumber });
  return changes;
}
