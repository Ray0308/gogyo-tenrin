export interface UnitDamageReductionState {
  nextDamageReduction: number;
  shellDamageReduction: number;
}

export interface AttackTargetUnit {
  keywords: string[];
}

export function randomAttackCandidates<T extends AttackTargetUnit>(units: T[]): T[] {
  return [...units];
}

export function isSelectableAttackUnit(
  units: AttackTargetUnit[],
  unit: AttackTargetUnit,
  ignoreTaunt = false,
): boolean {
  if (unit.keywords.includes("ステルス") && !unit.keywords.includes("挑発")) return false;
  if (ignoreTaunt) return true;
  const hasTaunt = units.some((candidate) => candidate.keywords.includes("挑発"));
  return !hasTaunt || unit.keywords.includes("挑発");
}

export function hasSelectableAttackUnit(
  units: AttackTargetUnit[],
  ignoreTaunt = false,
): boolean {
  return units.some((unit) => isSelectableAttackUnit(units, unit, ignoreTaunt));
}

export function reduceUnitDamage(
  amount: number,
  unit: UnitDamageReductionState,
  terrainReduction = 0,
  ignoreReduction = 0,
): number {
  const reduction = Math.max(
    0,
    unit.nextDamageReduction + unit.shellDamageReduction + terrainReduction - ignoreReduction,
  );
  const damage = Math.max(0, amount - reduction);
  if (unit.nextDamageReduction > 0) unit.nextDamageReduction = 0;
  return damage;
}

export function beginShikigamiAction(unit: UnitDamageReductionState): void {
  unit.shellDamageReduction = 0;
}

export function canCounterCardAttack(
  damaged: boolean,
  defenderHp: number,
  attackerHp: number,
  keywords: string[],
): boolean {
  return damaged && defenderHp > 0 && attackerHp > 0 && keywords.includes("反撃");
}
