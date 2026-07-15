export interface UnitDamageReductionState {
  nextDamageReduction: number;
  shellDamageReduction: number;
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
