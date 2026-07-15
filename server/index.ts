import express from "express";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  FIVE_ELEMENTS,
  type BattlePlayerState,
  type DefenseTarget,
  type CardPlayTarget,
  type CardTarget,
  type CardView,
  type ClientToServerEvents,
  type CurseState,
  type FiveElement,
  type ServerToClientEvents,
  type SessionState,
  type ShikigamiState,
} from "../shared/protocol.js";

interface CardMaster { id:string; name:string; category:string; system:string; attribute:string; templateId:string|null; cost:number; mpCost:number; weight:number; target:string; timing:string; effectText:string; description:string; flavorText:string }
interface ShikigamiMaster { id:string; name:string; attribute:string; maxHp:number; attack:number; aiProfile:string; keywords:string|null; ability:string; description:string; imageId:string }
interface FieldMaster { id:string; name:string; attribute:string; effectText:string; triggerCount?:number|null }
type AttributeMatchEffect =
  | { type:"apply_curse"; curseId:"curse_poison"|"curse_burn"; stacks:number }
  | { type:"next_damage_reduction"; amount:number }
  | { type:"ignore_damage_reduction"; amount:number }
  | { type:"gain_mp"; amount:number };
interface AttackDefinition { type:"attack"; cardId:string; target:"opponent_any"|"opponent_unit"|"opponent_units"; baseDamage:number; ignoreTaunt?:boolean; healSelf?:number; attributeMatchEffect?:AttributeMatchEffect }
interface TurnDefinition { type:"turn"; cardId:string; target:"self_player"; steps:number }
interface SummonDefinition { type:"summon"; cardId:string; target:"self_field"; shikigamiId:string }
interface FieldDefinition { type:"barrier"|"terrain"; cardId:string; target:"self_field"|"shared_field"; fieldId:string }
interface DefenseDefinition { type:"defense"; cardId:string; scope:"single"|"all"; mode:"reduce"|"nullify"; amount:number; postEffect?:"heal"|"retaliate"|"gain_mp"|"next_reduction"|"heal_lowest_damaged"; allowEffectDamage?:boolean }
type CardEffectDefinition = AttackDefinition|TurnDefinition|SummonDefinition|DefenseDefinition|FieldDefinition;
interface PendingReaction {
  eligibleCardIds:string[]; remainingMs:number; timer?:ReturnType<typeof setTimeout>;
  targets:{id:DefenseTarget;target:UnitTarget;predictedDamage:number}[];
  resolve:(definition?:DefenseDefinition,target?:DefenseTarget)=>void;
}
interface StoredSession { state:SessionState; cpuHand:CardView[]; cpuDiscard:CardView[]; pendingReaction?:PendingReaction; cpuCardActions:number; cpuShikigamiQueue?:string[] }
type Side = "player"|"cpu";
type UnitTarget = { type:"player" }|{ type:"unit"; unit:ShikigamiState };
type AttackSource = { type:"player" }|{ type:"unit"; unit:ShikigamiState };

const app=express();
export const server=createServer(app);
export const io=new Server<ClientToServerEvents,ServerToClientEvents>(server);
const port=Number(process.env.PORT??3000);
const currentDirectory=path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory=path.resolve(currentDirectory,"..");
const clientDirectory=path.join(distributionDirectory,"client");
const rootDocument=readFileSync(path.join(clientDirectory,"index.html"),"utf8");
const cards=loadJson<CardMaster[]>("cards.json");
const shikigami=loadJson<ShikigamiMaster[]>("shikigami.json");
const barriers=loadJson<FieldMaster[]>("barriers.json");
const terrains=loadJson<FieldMaster[]>("terrains.json");
const definitions=loadJson<CardEffectDefinition[]>("cardEffects.json");
const cardById=new Map(cards.map(card=>[card.id,card]));
const shikigamiById=new Map(shikigami.map(unit=>[unit.id,unit]));
const barrierById=new Map(barriers.map(field=>[field.id,field]));
const terrainById=new Map(terrains.map(field=>[field.id,field]));
const effectByCardId=new Map(definitions.map(effect=>[effect.cardId,effect]));
const totalCardWeight=cards.reduce((sum,card)=>sum+card.weight,0);
const sessions=new Map<string,StoredSession>();
const socketTokens=new Map<string,string>();
const cardAttributeToElement:Record<string,FiveElement|undefined>={"木":"wood","火":"fire","土":"earth","金":"metal","水":"water"};
const elementName:Record<FiveElement,string>={wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};
const generates:Record<FiveElement,FiveElement>={wood:"fire",fire:"earth",earth:"metal",metal:"water",water:"wood"};
const overcomes:Record<FiveElement,FiveElement>={wood:"earth",earth:"water",water:"fire",fire:"metal",metal:"wood"};

function loadJson<T>(name:string):T{return JSON.parse(readFileSync(path.join(currentDirectory,"data",name),"utf8")) as T}
function validateMaster():void{
  if(cards.length===0||totalCardWeight<=0)throw new Error("抽選可能なカードがありません。");
  const ids=new Set<string>();
  for(const card of cards){if(!/^[a-z0-9_]+$/.test(card.id)||ids.has(card.id)||card.cost<0||card.mpCost<0||card.weight<0)throw new Error(`カードマスターが不正です: ${card.id}`);ids.add(card.id)}
  for(const definition of definitions){if(!cardById.has(definition.cardId))throw new Error(`存在しないカードの効果です: ${definition.cardId}`);if(definition.type==="summon"&&!shikigamiById.has(definition.shikigamiId))throw new Error(`存在しない式神です: ${definition.shikigamiId}`);if(definition.type==="barrier"&&!barrierById.has(definition.fieldId))throw new Error(`存在しない結界です: ${definition.fieldId}`);if(definition.type==="terrain"&&!terrainById.has(definition.fieldId))throw new Error(`存在しない地形です: ${definition.fieldId}`)}
}
validateMaster();

function publicState(state:SessionState):SessionState{return structuredClone(state)}
function currentSession(socketId:string):StoredSession|undefined{const token=socketTokens.get(socketId);return token?sessions.get(token):undefined}
function sendState(socketId:string,state:SessionState):void{io.to(socketId).emit("session:state",publicState(state))}
function sendSessionState(session:StoredSession):void{for(const [socketId,token] of socketTokens){if(sessions.get(token)===session)sendState(socketId,session.state)}}
function drawCard():CardView{
  let cursor=(randomInt(0,1_000_000_000)/1_000_000_000)*totalCardWeight;let selected=cards[cards.length-1];
  for(const card of cards){cursor-=card.weight;if(cursor<0){selected=card;break}}
  return {instanceId:randomUUID(),cardId:selected.id,name:selected.name,category:selected.category,system:selected.system,attribute:selected.attribute,cost:selected.cost,mpCost:selected.mpCost,target:selected.target,timing:selected.timing,effectText:selected.effectText,description:selected.description,flavorText:selected.flavorText,playable:false,unusableReason:"使用可否を確認中です。"};
}
function drawCards(count:number):CardView[]{return Array.from({length:count},drawCard)}
function drawToLimit(hand:CardView[],count:number):void{for(let i=0;i<count&&hand.length<7;i++)hand.push(drawCard())}
function stateForSide(state:SessionState,side:Side):BattlePlayerState{return state.battle![side]}
function attributeForSide(state:SessionState,side:Side):FiveElement{return (side==="player"?state.playerAttribute:state.cpuAttribute)!}
function setAttributeForSide(state:SessionState,side:Side,value:FiveElement):void{if(side==="player")state.playerAttribute=value;else state.cpuAttribute=value}
function otherSide(side:Side):Side{return side==="player"?"cpu":"player"}
function handForSide(session:StoredSession,side:Side):CardView[]{return side==="player"?session.state.battle!.player.hand:session.cpuHand}
function discardForSide(session:StoredSession,side:Side):CardView[]{return side==="player"?session.state.battle!.player.discard:session.cpuDiscard}
function expectedPlayerTarget(definition:CardEffectDefinition):CardPlayTarget{
  if(definition.type==="attack"){if(definition.target==="opponent_any")return "cpu_any";if(definition.target==="opponent_unit")return "cpu_unit";return "cpu_field"}
  if(definition.type==="turn")return "player";if(definition.type==="terrain")return "shared_field";return "player_field";
}
function isDefinitionUsable(state:SessionState,side:Side,card:CardView,definition:CardEffectDefinition):string|undefined{
  const actor=stateForSide(state,side),opponent=stateForSide(state,otherSide(side));
  if(actor.cost<card.cost)return "コストが不足しています。";
  if(actor.mp<card.mpCost)return "MPが不足しています。";
  if(definition.type==="summon"&&actor.shikigami.length>=3)return "式神枠が満員です。";
  if(definition.type==="attack"&&definition.target!=="opponent_any"&&opponent.shikigami.length===0)return "対象となる相手式神が存在しません。";
  return undefined;
}
function refreshPlayability(state:SessionState):void{
  const battle=state.battle;if(!battle)return;
  for(const card of battle.player.hand){card.playTarget=undefined;card.ignoreTaunt=undefined;const definition=effectByCardId.get(card.cardId);
    if(battle.phase==="reaction"){card.playable=Boolean(battle.reaction?.eligibleCardIds.includes(card.instanceId));card.unusableReason=card.playable?undefined:"今回の反応受付では使用できません。"}
    else if(battle.phase!=="card_use"||battle.activePlayer!=="player"){card.playable=false;card.unusableReason="現在はカードを使用できません。"}
    else if(!definition||definition.type==="defense"){card.playable=false;card.unusableReason=definition?.type==="defense"?"防御札は反応受付中に使用します。":"このカードの構造化効果データは未接続です。"}
    else{const reason=isDefinitionUsable(state,"player",card,definition);card.playable=!reason;card.unusableReason=reason;card.playTarget=expectedPlayerTarget(definition);card.ignoreTaunt=definition.type==="attack"&&definition.ignoreTaunt}
  }
}
function addCurse(curses:CurseState[],curseId:"curse_poison"|"curse_burn",stacks=1):void{
  const existing=curses.find(curse=>curse.id===curseId);
  if(curseId==="curse_poison"){if(existing)existing.stacks=Math.min(5,existing.stacks+stacks);else curses.push({id:curseId,name:"毒",stacks:Math.min(5,stacks)});return}
  if(existing){existing.stacks=1;existing.remainingTriggers=2}else curses.push({id:curseId,name:"火傷",stacks:1,remainingTriggers:2});
}
function finishIfNeeded(state:SessionState):boolean{
  const battle=state.battle!;if(battle.player.hp<=0){battle.phase="finished";battle.winner="cpu";battle.log.push("プレイヤーのHPが0になり、CPUが勝利した。");return true}
  if(battle.cpu.hp<=0){battle.phase="finished";battle.winner="player";battle.log.push("CPUのHPが0になり、プレイヤーが勝利した。");return true}return false;
}
function applyDamageToPlayer(state:SessionState,side:Side,amount:number,ignoreReduction=0,curseDamage=false):number{
  const target=stateForSide(state,side),barrierReduction=!curseDamage&&target.barrier?.id==="barrier_guardian"?1:0,reduction=Math.max(0,target.nextDamageReduction+barrierReduction-ignoreReduction),damage=Math.max(0,amount-reduction);if(target.nextDamageReduction>0)target.nextDamageReduction=0;target.hp=Math.max(0,target.hp-damage);return damage;
}
function applyDamageToUnit(state:SessionState,unit:ShikigamiState,amount:number,ignoreReduction=0):number{const terrainReduction=state.battle?.terrain?.id==="terrain_sacred_domain"?1:0,reduction=Math.max(0,unit.nextDamageReduction+terrainReduction-ignoreReduction),damage=Math.max(0,amount-reduction);if(unit.nextDamageReduction>0)unit.nextDamageReduction=0;unit.hp=Math.max(0,unit.hp-damage);return damage}
function cleanupUnits(state:SessionState,side:Side):void{const owner=stateForSide(state,side),dead=owner.shikigami.filter(unit=>unit.hp<=0);for(const unit of dead){state.battle!.log.push(`${unit.name}が退場した。`);if(state.battle!.terrain?.id==="terrain_yomi_road"){owner.mp=Math.min(30,owner.mp+1);state.battle!.log.push(`黄泉路により${side==="player"?"プレイヤー":"CPU"}のMPが1増加した。`)}}owner.shikigami=owner.shikigami.filter(unit=>unit.hp>0)}
function applyTargetCurse(state:SessionState,side:Side,target:UnitTarget,effect:AttributeMatchEffect):void{
  if(effect.type!=="apply_curse")return;const curses=target.type==="player"?stateForSide(state,otherSide(side)).curses:target.unit.curses;addCurse(curses,effect.curseId,effect.stacks);state.battle!.log.push(`${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}に呪い：${effect.curseId==="curse_poison"?"毒":"火傷"}を付与した。`);
}
function applySelfMatchEffect(state:SessionState,side:Side,effect:AttributeMatchEffect|undefined):number{
  if(!effect||effect.type==="apply_curse")return 0;const battle=state.battle!,actor=stateForSide(state,side);
  if(effect.type==="next_damage_reduction"){actor.nextDamageReduction=Math.max(actor.nextDamageReduction,effect.amount);battle.log.push(`次に受けるダメージを${effect.amount}軽減する効果を得た。`)}
  else if(effect.type==="ignore_damage_reduction"){battle.log.push(`この攻撃はダメージ軽減を${effect.amount}無視する。`);return effect.amount}
  else{actor.mp=Math.min(30,actor.mp+effect.amount);battle.log.push(`属性固有効果でMPが${effect.amount}増加した。`)}
  return 0;
}
function findUnitTarget(state:SessionState,side:Side,target:CardTarget|undefined):ShikigamiState|undefined{
  if(!target||!target.startsWith("cpu_unit:"))return undefined;return stateForSide(state,otherSide(side)).shikigami.find(unit=>unit.instanceId===target.slice("cpu_unit:".length));
}
function validUnitAttackTarget(state:SessionState,side:Side,definition:AttackDefinition,unit:ShikigamiState):boolean{
  const units=stateForSide(state,otherSide(side)).shikigami,taunts=units.filter(candidate=>candidate.keywords.includes("挑発"));
  if(unit.keywords.includes("ステルス")&&!unit.keywords.includes("挑発"))return false;
  return Boolean(definition.ignoreTaunt)||taunts.length===0||unit.keywords.includes("挑発");
}
function validateAttackTarget(state:SessionState,side:Side,definition:AttackDefinition,target:CardTarget|undefined):boolean{
  if(side==="cpu")return true;if(definition.target==="opponent_units")return target==="cpu_field";
  if(target==="cpu_player")return definition.target==="opponent_any"&&(Boolean(definition.ignoreTaunt)||!stateForSide(state,otherSide(side)).shikigami.some(unit=>unit.keywords.includes("挑発")));
  const unit=findUnitTarget(state,side,target);return Boolean(unit&&validUnitAttackTarget(state,side,definition,unit));
}
function attackTargets(state:SessionState,side:Side,definition:AttackDefinition,target:CardTarget|undefined):UnitTarget[]{
  const opponent=stateForSide(state,otherSide(side));if(definition.target==="opponent_units")return opponent.shikigami.map(unit=>({type:"unit",unit}));
  if(side==="player"){if(target==="cpu_player")return [{type:"player"}];const unit=findUnitTarget(state,side,target);return unit?[{type:"unit",unit}]:[]}
  let units=opponent.shikigami.filter(unit=>validUnitAttackTarget(state,side,definition,unit));const taunts=units.filter(unit=>unit.keywords.includes("挑発"));
  if(!definition.ignoreTaunt&&taunts.length)units=taunts;
  if(definition.target==="opponent_unit"||(!definition.ignoreTaunt&&taunts.length))return units.length?[{type:"unit",unit:units[randomInt(units.length)]}]:[];
  return [{type:"player"}];
}function triggerBurnAfterCard(state:SessionState,side:Side):void{
  const actor=stateForSide(state,side),burn=actor.curses.find(curse=>curse.id==="curse_burn");if(!burn)return;
  const damage=applyDamageToPlayer(state,side,1,0,true);state.battle!.log.push(`火傷により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`);burn.remainingTriggers=(burn.remainingTriggers??2)-1;if(burn.remainingTriggers<=0)actor.curses=actor.curses.filter(curse=>curse!==burn);
}
function createShikigami(master:ShikigamiMaster):ShikigamiState{return {instanceId:randomUUID(),shikigamiId:master.id,name:master.name,attribute:master.attribute,hp:master.maxHp,maxHp:master.maxHp,attack:master.attack,aiProfile:master.aiProfile,keywords:master.keywords?master.keywords.split(/[・、,]/).filter(Boolean):[],ability:master.ability,curses:[],nextDamageReduction:0,nextAttackBonus:0}}
function createFieldState(master:FieldMaster){return {id:master.id,name:master.name,attribute:master.attribute,effectText:master.effectText,triggerCount:master.triggerCount??undefined}}
function defenseTargetId(target:UnitTarget):DefenseTarget{return target.type==="player"?"player":`player_unit:${target.unit.instanceId}`}
function defenseTargetLabel(target:UnitTarget):string{return target.type==="player"?"プレイヤー":target.unit.name}
function defenseCards(session:StoredSession,side:Side):{card:CardView;definition:DefenseDefinition}[]{
  const actor=stateForSide(session.state,side);return handForSide(session,side).flatMap(card=>{const definition=effectByCardId.get(card.cardId);return definition?.type==="defense"&&card.cost===0&&actor.mp>=card.mpCost?[{card,definition}]:[]});
}
function consumeUsedCard(session:StoredSession,side:Side,index:number):CardView{
  const battle=session.state.battle!,hand=handForSide(session,side),[used]=hand.splice(index,1);used.playable=false;used.unusableReason="使用済みです。";used.playTarget=undefined;discardForSide(session,side).push(used);if(side==="cpu")battle.cpu.handCount=session.cpuHand.length;return used;
}
function applyDefensePostEffect(state:SessionState,defenderSide:Side,definition:DefenseDefinition,protectedTargets:UnitTarget[],damagedTargets:UnitTarget[],prevented:number,attackerSide:Side,source:AttackSource={type:"player"}):void{
  const battle=state.battle!,defender=stateForSide(state,defenderSide);
  if(definition.postEffect==="heal"&&protectedTargets[0]){const target=protectedTargets[0];if(target.type==="player")defender.hp=Math.min(30,defender.hp+1);else target.unit.hp=Math.min(target.unit.maxHp,target.unit.hp+1);battle.log.push(`${defenseTargetLabel(target)}のHPが1回復した。`)}
  else if(definition.postEffect==="heal_lowest_damaged"&&damagedTargets.length){const sorted=[...damagedTargets].sort((a,b)=>{const ar=a.type==="player"?defender.hp/30:a.unit.hp/a.unit.maxHp,br=b.type==="player"?defender.hp/30:b.unit.hp/b.unit.maxHp;return ar-br});const target=sorted[0];if(target.type==="player")defender.hp=Math.min(30,defender.hp+1);else target.unit.hp=Math.min(target.unit.maxHp,target.unit.hp+1);battle.log.push(`${defenseTargetLabel(target)}のHPが1回復した。`)}
  else if(definition.postEffect==="gain_mp"){defender.mp=Math.min(30,defender.mp+1);battle.log.push(`${defenderSide==="player"?"プレイヤー":"CPU"}のMPが1増加した。`)}
  else if(definition.postEffect==="next_reduction"&&protectedTargets[0]){const target=protectedTargets[0];if(target.type==="player")defender.nextDamageReduction=Math.max(defender.nextDamageReduction,1);else target.unit.nextDamageReduction=Math.max(target.unit.nextDamageReduction,1);battle.log.push(`${defenseTargetLabel(target)}は次に受けるダメージを1軽減する。`)}
  else if(definition.postEffect==="retaliate"&&prevented>0){const damage=source.type==="player"?applyDamageToPlayer(state,attackerSide,1):applyDamageToUnit(state,source.unit,1);battle.log.push(`防御札の反撃により${source.type==="player"?(attackerSide==="player"?"プレイヤー":"CPU"):source.unit.name}へ${damage}ダメージ。`)}
}
function resolveCardAttack(state:SessionState,side:Side,card:CardView,definition:AttackDefinition,targets:UnitTarget[],cardElement:FiveElement,match:boolean,ignore:number,defense?:DefenseDefinition,selectedTarget?:DefenseTarget):void{
  const battle=state.battle!,defenderSide=otherSide(side),protectedTargets=defense?(defense.scope==="all"?targets:targets.filter(target=>defenseTargetId(target)===selectedTarget)):[],damagedTargets:UnitTarget[]=[];let prevented=0;
  for(const target of targets){const targetElement=targetAttribute(state,side,target),overcoming=Boolean(targetElement&&overcomes[cardElement]===targetElement),raw=definition.baseDamage+(match?1:0)+(overcoming?2:0),protectedTarget=protectedTargets.includes(target),adjusted=protectedTarget?(defense!.mode==="nullify"?0:Math.max(0,raw-defense!.amount)):raw;prevented+=raw-adjusted;const damage=target.type==="player"?applyDamageToPlayer(state,defenderSide,adjusted,ignore):applyDamageToUnit(state,target.unit,adjusted,ignore);if(damage>0)damagedTargets.push(target);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用し、${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}へ${damage}ダメージ。`);if(match&&definition.attributeMatchEffect)applyTargetCurse(state,side,target,definition.attributeMatchEffect);if(overcoming)battle.log.push("相剋成立：ダメージに＋2。");}
  if(match)battle.log.push("属性一致：基本効果量に＋1。");if(definition.healSelf)stateForSide(state,side).hp=Math.min(30,stateForSide(state,side).hp+definition.healSelf);if(defense)applyDefensePostEffect(state,defenderSide,defense,protectedTargets,damagedTargets,prevented,side);cleanupUnits(state,defenderSide);cleanupUnits(state,side);
}
function armReactionTimer(session:StoredSession,pending:PendingReaction):void{const battle=session.state.battle!;const duration=Math.max(0,pending.remainingMs);if(battle.reaction)battle.reaction.deadline=Date.now()+duration;pending.timer=setTimeout(()=>{if(session.pendingReaction!==pending)return;battle.log.push("反応受付が時間切れとなった。");finishReaction(session);sendSessionState(session)},duration)}
function beginReaction(session:StoredSession,sourceName:string,attackerName:string,targets:UnitTarget[],predictions:number[],resolve:(definition?:DefenseDefinition,target?:DefenseTarget)=>void):void{
  const battle=session.state.battle!,eligible=defenseCards(session,"player");battle.phase="reaction";battle.log.push(`${sourceName}に対する反応受付を開始した。`);battle.reaction={sourceName,attackerName,targets:targets.map((target,index)=>({id:defenseTargetId(target),label:defenseTargetLabel(target),predictedDamage:predictions[index]})),eligibleCardIds:eligible.map(item=>item.card.instanceId),deadline:Date.now()+10_000};const pending:PendingReaction={eligibleCardIds:battle.reaction.eligibleCardIds,remainingMs:10_000,targets:targets.map((target,index)=>({id:defenseTargetId(target),target,predictedDamage:predictions[index]})),resolve};session.pendingReaction=pending;armReactionTimer(session,pending);refreshPlayability(session.state);
}
function finishReaction(session:StoredSession,instanceId?:string,targetId?:DefenseTarget):{ok:boolean;message?:string}{
  const pending=session.pendingReaction,battle=session.state.battle;if(!pending||!battle||battle.phase!=="reaction")return {ok:false,message:"現在は反応受付中ではありません。"};let definition:DefenseDefinition|undefined;
  if(instanceId){if(!pending.eligibleCardIds.includes(instanceId))return {ok:false,message:"この防御札は使用できません。"};const index=battle.player.hand.findIndex(card=>card.instanceId===instanceId);const card=battle.player.hand[index],effect=card?effectByCardId.get(card.cardId):undefined;if(!card||effect?.type!=="defense")return {ok:false,message:"防御札が見つかりません。"};if(effect.scope==="single"){if(pending.targets.length===1)targetId=pending.targets[0].id;if(!targetId||!pending.targets.some(target=>target.id===targetId))return {ok:false,message:"防御する対象を選択してください。"}}stateForSide(session.state,"player").mp-=card.mpCost;consumeUsedCard(session,"player",index);definition=effect;battle.log.push(`プレイヤーが${card.name}を使用した。`)}else battle.log.push("プレイヤーは防御札を使用しなかった。");
  if(pending.timer)clearTimeout(pending.timer);delete session.pendingReaction;delete battle.reaction;pending.resolve(definition,targetId);return {ok:true};
}
function executeCard(session:StoredSession,side:Side,index:number,externalTarget?:CardTarget):{ok:boolean;message?:string;paused?:boolean}{
  const state=session.state,battle=state.battle!,hand=handForSide(session,side),card=hand[index],definition=card?effectByCardId.get(card.cardId):undefined;
  if(!card)return {ok:false,message:"手札に存在しないカードです。"};if(!definition||definition.type==="defense")return {ok:false,message:"このカードの効果処理はまだ接続されていません。"};
  if(definition.type==="attack"){if(!validateAttackTarget(state,side,definition,externalTarget))return {ok:false,message:"対象が不正です。"}}else if(side==="player"&&externalTarget!==expectedPlayerTarget(definition))return {ok:false,message:"対象が不正です。"};
  const reason=isDefinitionUsable(state,side,card,definition);if(reason)return {ok:false,message:reason};const actor=stateForSide(state,side),actorAttribute=attributeForSide(state,side),cardElement=cardAttributeToElement[card.attribute];if(!cardElement&&definition.type!=="summon"&&definition.type!=="barrier"&&definition.type!=="terrain")return {ok:false,message:"カード属性が不正です。"};actor.cost-=card.cost;actor.mp-=card.mpCost;
  if(definition.type==="attack"){
    const match=cardElement===actorAttribute,selectedTargets=attackTargets(state,side,definition,externalTarget),targets=selectedTargets.length===1?[redirectCover(state,side,selectedTargets[0])]:selectedTargets,ignore=match?applySelfMatchEffect(state,side,definition.attributeMatchEffect):0;consumeUsedCard(session,side,index);const resolve=(defense?:DefenseDefinition,defenseTarget?:DefenseTarget)=>{resolveCardAttack(state,side,card,definition,targets,cardElement!,match,ignore,defense,defenseTarget);if(cardElement&&generates[actorAttribute]===cardElement){actor.mp=Math.min(30,actor.mp+1);battle.log.push("相生成立：MPが1増加した。")}triggerBurnAfterCard(state,side);finishIfNeeded(state);refreshPlayability(state)};
    if(side==="cpu"&&defenseCards(session,"player").length){const predictions=targets.map(target=>{const targetElement=targetAttribute(state,side,target);return definition.baseDamage+(match?1:0)+(targetElement&&overcomes[cardElement!]===targetElement?2:0)});beginReaction(session,card.name,"CPU",targets,predictions,(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))continueCpuTurn(session)});return {ok:true,paused:true}}
    if(side==="player"){const choices=defenseCards(session,"cpu"),choice=choices.find(item=>item.definition.scope==="all"||targets.length===1);if(choice&&targets.some(target=>target.type==="player"?stateForSide(state,"cpu").hp<=definition.baseDamage+2:target.unit.hp<=definition.baseDamage+2)){const cpuIndex=session.cpuHand.findIndex(item=>item.instanceId===choice.card.instanceId);stateForSide(state,"cpu").mp-=choice.card.mpCost;consumeUsedCard(session,"cpu",cpuIndex);battle.log.push(`CPUが${choice.card.name}を使用した。`);resolve(choice.definition,choice.definition.scope==="single"?defenseTargetId(targets[0]):undefined)}else resolve()}else resolve();return {ok:true};
  }
  if(definition.type==="turn"){const current=FIVE_ELEMENTS.indexOf(actorAttribute),next=FIVE_ELEMENTS[(current+definition.steps%5+5)%5];setAttributeForSide(state,side,next);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用し、${elementName[actorAttribute]}から${elementName[next]}へ転輪した。`)}else if(definition.type==="summon"){const master=shikigamiById.get(definition.shikigamiId)!;actor.shikigami.push(createShikigami(master));battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${master.name}を召喚した。`)}else if(definition.type==="barrier"){const master=barrierById.get(definition.fieldId)!;if(actor.barrier)battle.log.push(`${actor.barrier.name}が消滅した。`);actor.barrier=createFieldState(master);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${master.name}を設置した。`)}else{const master=terrainById.get(definition.fieldId)!;if(battle.terrain)battle.log.push(`${battle.terrain.name}が消滅した。`);battle.terrain=createFieldState(master);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${master.name}を展開した。`)}
  if(cardElement&&generates[actorAttribute]===cardElement){actor.mp=Math.min(30,actor.mp+1);battle.log.push("相生成立：MPが1増加した。")}consumeUsedCard(session,side,index);triggerBurnAfterCard(state,side);finishIfNeeded(state);refreshPlayability(state);return {ok:true};
}
function usePlayerCard(session:StoredSession,instanceId:string,target:CardTarget):{ok:boolean;message?:string}{const battle=session.state.battle;if(!battle||session.state.phase!=="battle"||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はカードを使用できません。"};const index=battle.player.hand.findIndex(card=>card.instanceId===instanceId);return executeCard(session,"player",index,target)}
function chooseUnitTarget(state:SessionState,side:Side,unit:ShikigamiState):UnitTarget{
  const opponent=stateForSide(state,otherSide(side));const taunts=opponent.shikigami.filter(target=>target.keywords.includes("挑発"));let units=taunts.length?taunts:opponent.shikigami.filter(target=>!target.keywords.includes("ステルス"));if(taunts.length)return {type:"unit",unit:taunts[randomInt(taunts.length)]};
  if(unit.aiProfile.includes("相手式神")||unit.aiProfile.includes("攻撃力が最も高い")){if(units.length){if(unit.aiProfile.includes("攻撃力"))units=[...units].sort((a,b)=>b.attack-a.attack);return {type:"unit",unit:units[0]}}}
  if(unit.aiProfile.includes("HPが最も低い")){const all:UnitTarget[]=[{type:"player"},...units.map(target=>({type:"unit" as const,unit:target}))];return all.sort((a,b)=>(a.type==="player"?opponent.hp:a.unit.hp)-(b.type==="player"?opponent.hp:b.unit.hp))[0]}
  if(unit.aiProfile.includes("ランダム")){const all:UnitTarget[]=[{type:"player"},...units.map(target=>({type:"unit" as const,unit:target}))];return all[randomInt(all.length)]}
  return {type:"player"};
}
function targetAttribute(state:SessionState,side:Side,target:UnitTarget):FiveElement|undefined{return target.type==="player"?attributeForSide(state,otherSide(side)):cardAttributeToElement[target.unit.attribute]}
function redirectCover(state:SessionState,side:Side,target:UnitTarget):UnitTarget{
  const cover=stateForSide(state,otherSide(side)).shikigami.find(unit=>unit.keywords.includes("かばう")&&(target.type==="player"||unit.instanceId!==target.unit.instanceId));if(!cover)return target;state.battle!.log.push(`${cover.name}が${defenseTargetLabel(target)}をかばった。`);return {type:"unit",unit:cover};
}
function shikigamiIsAlive(state:SessionState,side:Side,unit:ShikigamiState):boolean{return stateForSide(state,side).shikigami.some(candidate=>candidate.instanceId===unit.instanceId&&candidate.hp>0)}
function resolveShikigamiAttack(state:SessionState,side:Side,unit:ShikigamiState,target:UnitTarget,hits:number[],defense?:DefenseDefinition,selectedTarget?:DefenseTarget):void{
  const battle=state.battle!,actor=stateForSide(state,side),opponentSide=otherSide(side),opponent=stateForSide(state,opponentSide),protectedTarget=Boolean(defense&&(defense.scope==="all"||defenseTargetId(target)===selectedTarget));let reduction=protectedTarget&&defense?.mode==="reduce"?defense.amount:0,prevented=0,dealt=0,piercing=0;
  for(const hit of hits){if(target.type==="unit"&&target.unit.hp<=0)break;let adjusted=hit;if(protectedTarget&&defense?.mode==="nullify")adjusted=0;else if(reduction>0){const used=Math.min(reduction,adjusted);adjusted-=used;reduction-=used}prevented+=hit-adjusted;if(target.type==="player")dealt+=applyDamageToPlayer(state,opponentSide,adjusted);else{const hpBefore=target.unit.hp,damage=applyDamageToUnit(state,target.unit,adjusted);dealt+=Math.min(hpBefore,damage);if(unit.keywords.includes("貫通")&&damage>hpBefore)piercing+=damage-hpBefore}}
  battle.log.push(`${unit.name}が${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}へ${dealt}ダメージ。`);
  if(piercing>0){const damage=applyDamageToPlayer(state,opponentSide,piercing);battle.log.push(`貫通により${opponentSide==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`)}
  const damagedTargets=dealt>0?[target]:[];if(defense)applyDefensePostEffect(state,opponentSide,defense,[target],damagedTargets,prevented,side,{type:"unit",unit});
  cleanupUnits(state,opponentSide);cleanupUnits(state,side);
  const targetAlive=target.type==="unit"&&shikigamiIsAlive(state,opponentSide,target.unit),attackerAlive=shikigamiIsAlive(state,side,unit);
  if(targetAlive&&attackerAlive&&target.unit.keywords.includes("反撃")){const damage=applyDamageToUnit(state,unit,1);battle.log.push(`${target.unit.name}の反撃により${unit.name}へ${damage}ダメージ。`);if(target.unit.shikigamiId==="shikigami_shirozaru")target.unit.nextAttackBonus=Math.max(target.unit.nextAttackBonus,1);cleanupUnits(state,side)}
  if(shikigamiIsAlive(state,side,unit)){
    if(unit.shikigamiId==="shikigami_orochi"&&target.type==="unit"&&dealt>0&&shikigamiIsAlive(state,opponentSide,target.unit)){addCurse(target.unit.curses,"curse_poison");battle.log.push(`${target.unit.name}に呪い：毒を1スタック付与した。`)}
    if(unit.shikigamiId==="shikigami_hinotori"&&dealt>0){if(target.type==="player")addCurse(opponent.curses,"curse_burn");else if(shikigamiIsAlive(state,opponentSide,target.unit))addCurse(target.unit.curses,"curse_burn")}
    if(unit.shikigamiId==="shikigami_karasutengu"){const others=opponent.shikigami.filter(enemy=>target.type!=="unit"||enemy.instanceId!==target.unit.instanceId);if(others.length){const splash=others[randomInt(others.length)],damage=applyDamageToUnit(state,splash,1);battle.log.push(`天狗風により${splash.name}へ${damage}ダメージ。`)}}
  }
  cleanupUnits(state,opponentSide);
  if(shikigamiIsAlive(state,side,unit)){
    if(unit.shikigamiId==="shikigami_kanko"){actor.mp=Math.min(30,actor.mp+1);battle.log.push("霊気集めによりMPが1増加した。")}
    if(unit.shikigamiId==="shikigami_kappa"&&actor.shikigami.length){const heal=[...actor.shikigami].sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];heal.hp=Math.min(heal.maxHp,heal.hp+1);battle.log.push(`水薬により${heal.name}のHPが1回復。`)}
    if(unit.shikigamiId==="shikigami_komainu")unit.nextDamageReduction=Math.max(unit.nextDamageReduction,1);
    const burn=unit.curses.find(curse=>curse.id==="curse_burn");if(burn){const damage=applyDamageToUnit(state,unit,1);battle.log.push(`火傷により${unit.name}へ${damage}ダメージ。`);burn.remainingTriggers=(burn.remainingTriggers??2)-1;if(burn.remainingTriggers<=0)unit.curses=unit.curses.filter(curse=>curse!==burn);cleanupUnits(state,side)}
  }
  finishIfNeeded(state);
}
function runOneShikigamiAction(session:StoredSession,side:Side,unit:ShikigamiState):{paused:boolean}{
  const state=session.state,battle=state.battle!,opponent=stateForSide(state,otherSide(side));
  if(unit.shikigamiId==="shikigami_genki"&&unit.hp<=unit.maxHp/2&&unit.nextDamageReduction<2){unit.nextDamageReduction=2;battle.log.push(`${unit.name}は甲羅籠りを行った。`);return {paused:false}}
  const target=redirectCover(state,side,chooseUnitTarget(state,side,unit)),unitElement=cardAttributeToElement[unit.attribute]!,targetElement=targetAttribute(state,side,target);let total=unit.attack+unit.nextAttackBonus+(unitElement===attributeForSide(state,side)?1:0)+(targetElement&&overcomes[unitElement]===targetElement?2:0);unit.nextAttackBonus=0;
  if(unit.shikigamiId==="shikigami_hakuro"){const hpValues=[opponent.hp,...opponent.shikigami.map(enemy=>enemy.hp)],targetHp=target.type==="player"?opponent.hp:target.unit.hp;if(targetHp===Math.min(...hpValues))total+=1}
  const hits=unit.shikigamiId==="shikigami_kamaitachi"?[Math.ceil(total/2),Math.floor(total/2)]:[total],resolve=(defense?:DefenseDefinition,defenseTarget?:DefenseTarget)=>resolveShikigamiAttack(state,side,unit,target,hits,defense,defenseTarget);
  if(side==="cpu"&&defenseCards(session,"player").length){beginReaction(session,"通常攻撃",unit.name,[target],[hits.reduce((sum,hit)=>sum+hit,0)],(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))continueCpuTurn(session)});return {paused:true}}
  if(side==="player"){const choices=defenseCards(session,"cpu"),choice=choices[0];if(choice&&((target.type==="player"?opponent.hp:target.unit.hp)<=total)){const index=session.cpuHand.findIndex(card=>card.instanceId===choice.card.instanceId);opponent.mp-=choice.card.mpCost;consumeUsedCard(session,"cpu",index);battle.log.push(`CPUが${choice.card.name}を使用した。`);resolve(choice.definition,choice.definition.scope==="single"?defenseTargetId(target):undefined)}else resolve()}else resolve();return {paused:false};
}
function runPlayerShikigamiPhase(session:StoredSession):void{const state=session.state;for(const instanceId of stateForSide(state,"player").shikigami.map(unit=>unit.instanceId)){const unit=stateForSide(state,"player").shikigami.find(candidate=>candidate.instanceId===instanceId);if(!unit||finishIfNeeded(state))break;runOneShikigamiAction(session,"player",unit)}}
function removeOneCurse(curses:CurseState[]):boolean{if(!curses.length)return false;const curse=curses[0];if(curse.stacks>1)curse.stacks-=1;else curses.shift();return true}
function processTurnStart(state:SessionState,side:Side):void{
  const battle=state.battle!,actor=stateForSide(state,side),opponent=stateForSide(state,otherSide(side));
  if(battle.terrain?.id==="terrain_clear_stream"){battle.player.mp=Math.min(30,battle.player.mp+1);battle.cpu.mp=Math.min(30,battle.cpu.mp+1);battle.log.push("清流により両プレイヤーのMPが1増加した。")}else if(battle.terrain?.id==="terrain_mineral_vein"){actor.cost+=1;battle.log.push(`鉱脈により${side==="player"?"プレイヤー":"CPU"}のコストが1増加した。`)}
  if(actor.barrier?.id==="barrier_spirit_vein"){actor.mp=Math.min(30,actor.mp+1);battle.log.push(`霊脈結界により${side==="player"?"プレイヤー":"CPU"}のMPが1増加した。`)}
  if(opponent.barrier?.id==="barrier_binding"){const candidates=actor.shikigami;if(candidates.length){const target=candidates[randomInt(candidates.length)],existing=target.curses.find(curse=>curse.id==="curse_binding");if(existing)existing.remainingTriggers=1;else target.curses.push({id:"curse_binding",name:"呪縛",stacks:1,remainingTriggers:1});battle.log.push(`呪縛結界により${target.name}へ呪い：呪縛を付与した。`)}opponent.barrier.triggerCount=(opponent.barrier.triggerCount??1)-1;if(opponent.barrier.triggerCount<=0){battle.log.push("呪縛結界が消滅した。");delete opponent.barrier}}
}
function processTurnEnd(state:SessionState,side:Side):void{
  const battle=state.battle!,actor=stateForSide(state,side);
  if(actor.barrier?.id==="barrier_purification"){let removed=removeOneCurse(actor.curses);if(!removed){const candidates=actor.shikigami.filter(unit=>unit.curses.length).sort((a,b)=>b.curses.length-a.curses.length);if(candidates[0])removed=removeOneCurse(candidates[0].curses)}if(removed)battle.log.push("浄化結界が自分側の呪いを1つ解除した。")}
  if(battle.terrain?.id==="terrain_chinju_forest"){for(const owner of [battle.player,battle.cpu])for(const unit of owner.shikigami)unit.hp=Math.min(unit.maxHp,unit.hp+1);battle.log.push("鎮守の森がすべての式神を1回復した。")}
  else if(battle.terrain?.id==="terrain_scorched_earth"){for(const owner of [battle.player,battle.cpu])for(const unit of owner.shikigami)applyDamageToUnit(state,unit,1);battle.log.push("焦土がすべての式神へ1ダメージを与えた。");cleanupUnits(state,"player");cleanupUnits(state,"cpu")}
  for(const unit of actor.shikigami)unit.curses=unit.curses.filter(curse=>curse.id!=="curse_binding");finishIfNeeded(state);
}function resolvePoisonAtTurnEnd(state:SessionState,side:Side):void{
  const battle=state.battle!,owner=stateForSide(state,side),poison=owner.curses.find(curse=>curse.id==="curse_poison");if(poison){const damage=applyDamageToPlayer(state,side,poison.stacks,0,true);battle.log.push(`毒により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`)}
  for(const unit of owner.shikigami){const curse=unit.curses.find(item=>item.id==="curse_poison");if(curse){const damage=applyDamageToUnit(state,unit,curse.stacks);battle.log.push(`毒により${unit.name}へ${damage}ダメージ。`)}}cleanupUnits(state,side);finishIfNeeded(state);
}
function continueCpuTurn(session:StoredSession):void{
  const state=session.state,battle=state.battle!;
  if(!session.cpuShikigamiQueue){while(session.cpuCardActions<5&&!finishIfNeeded(state)){const candidates=session.cpuHand.map((card,index)=>({card,index,definition:effectByCardId.get(card.cardId)})).filter(item=>item.definition&&item.definition.type!=="defense"&&!isDefinitionUsable(state,"cpu",item.card,item.definition));if(!candidates.length)break;const score=(item:typeof candidates[number])=>item.definition!.type==="attack"?3:item.definition!.type==="summon"?2:1;const best=Math.max(...candidates.map(score)),choices=candidates.filter(item=>score(item)===best),chosen=choices[randomInt(choices.length)];session.cpuCardActions+=1;const result=executeCard(session,"cpu",chosen.index);if(result.paused){battle.cpu.handCount=session.cpuHand.length;refreshPlayability(state);return}}battle.cpu.handCount=session.cpuHand.length;session.cpuShikigamiQueue=stateForSide(state,"cpu").shikigami.map(unit=>unit.instanceId);battle.phase="resolving";battle.log.push("CPUの式神行動フェーズ。")}
  while(session.cpuShikigamiQueue.length&&!finishIfNeeded(state)){const instanceId=session.cpuShikigamiQueue.shift()!,unit=stateForSide(state,"cpu").shikigami.find(candidate=>candidate.instanceId===instanceId);if(!unit)continue;const result=runOneShikigamiAction(session,"cpu",unit);if(result.paused){refreshPlayability(state);return}}
  delete session.cpuShikigamiQueue;processTurnEnd(state,"cpu");resolvePoisonAtTurnEnd(state,"cpu");if(finishIfNeeded(state)){refreshPlayability(state);return}
  battle.turnNumber+=1;battle.activePlayer="player";battle.phase="card_use";battle.player.cost=5;processTurnStart(state,"player");drawToLimit(battle.player.hand,5);battle.log.push(`第${battle.turnNumber}ターン開始。手札とコストを更新した。`);refreshPlayability(state);
}
function endPlayerTurn(session:StoredSession):{ok:boolean;message?:string}{
  const state=session.state,battle=state.battle;if(!battle||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はターンを終了できません。"};battle.phase="resolving";battle.log.push("プレイヤーの式神行動フェーズ。");runPlayerShikigamiPhase(session);processTurnEnd(state,"player");resolvePoisonAtTurnEnd(state,"player");if(finishIfNeeded(state)){refreshPlayability(state);return {ok:true}}
  battle.activePlayer="cpu";stateForSide(state,"cpu").cost=5;processTurnStart(state,"cpu");drawToLimit(session.cpuHand,5);battle.cpu.handCount=session.cpuHand.length;battle.log.push("CPUターン開始。");session.cpuCardActions=0;delete session.cpuShikigamiQueue;continueCpuTurn(session);return {ok:true};
}

app.get("/health",(_request,response)=>response.json({status:"ok"}));app.use(express.static(distributionDirectory));app.get("/",(_request,response)=>response.type("html").send(rootDocument));
io.on("connection",socket=>{
  sendState(socket.id,{phase:"title"});
  socket.on("session:resume",(token,callback)=>{const session=sessions.get(token);if(!session){callback({ok:false,message:"復帰できる対戦がありません。"});return}socketTokens.set(socket.id,token);if(session.pendingReaction&&!session.pendingReaction.timer)armReactionTimer(session,session.pendingReaction);refreshPlayability(session.state);callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("cpu:start",({playerName},callback)=>{const name=playerName.trim();if(!name){callback({ok:false,message:"プレイヤー名を入力してください。"});return}const previous=socketTokens.get(socket.id);if(previous)sessions.delete(previous);const token=randomUUID(),state:SessionState={phase:"attribute_selection",reconnectToken:token,playerName:name};sessions.set(token,{state,cpuHand:[],cpuDiscard:[],cpuCardActions:0});socketTokens.set(socket.id,token);callback({ok:true,state:publicState(state)});sendState(socket.id,state)});
  socket.on("attribute:select",({attribute},callback)=>{const session=currentSession(socket.id);if(!session||session.state.phase!=="attribute_selection"){callback({ok:false,message:"現在は属性を選択できません。"});return}if(!FIVE_ELEMENTS.includes(attribute)){callback({ok:false,message:"選択した属性が不正です。"});return}session.state.playerAttribute=attribute;session.state.cpuAttribute=FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];session.state.phase="attribute_reveal";callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("match:enter",callback=>{const session=currentSession(socket.id);if(!session||session.state.phase!=="attribute_reveal"){callback({ok:false,message:"対戦を開始できません。"});return}const hand=drawCards(5);session.cpuHand=drawCards(5);session.state.phase="battle";session.state.battle={turnNumber:1,activePlayer:"player",phase:"card_use",player:{hp:30,mp:0,cost:5,curses:[],nextDamageReduction:0,shikigami:[],hand,discard:[]},cpu:{hp:30,mp:0,cost:5,curses:[],nextDamageReduction:0,shikigami:[],handCount:session.cpuHand.length},log:["対戦を開始した。双方が5枚引いた。"]};refreshPlayability(session.state);callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("card:use",({instanceId,target},callback)=>{const session=currentSession(socket.id);if(!session){callback({ok:false,message:"対戦情報がありません。"});return}const result=usePlayerCard(session,instanceId,target);if(!result.ok){callback(result);return}callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("reaction:respond",({instanceId,target},callback)=>{const session=currentSession(socket.id);if(!session){callback({ok:false,message:"対戦情報がありません。"});return}const result=finishReaction(session,instanceId,target);if(!result.ok){callback(result);return}callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("turn:end",callback=>{const session=currentSession(socket.id);if(!session){callback({ok:false,message:"対戦情報がありません。"});return}const result=endPlayerTurn(session);if(!result.ok){callback(result);return}callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("session:reset",callback=>{const session=currentSession(socket.id);if(session?.pendingReaction?.timer)clearTimeout(session.pendingReaction.timer);const token=socketTokens.get(socket.id);if(token)sessions.delete(token);socketTokens.delete(socket.id);const state:SessionState={phase:"title"};callback({ok:true,state});sendState(socket.id,state)});socket.on("disconnect",()=>{const session=currentSession(socket.id),pending=session?.pendingReaction,battle=session?.state.battle;if(pending?.timer&&battle?.reaction){pending.remainingMs=Math.max(0,battle.reaction.deadline-Date.now());clearTimeout(pending.timer);pending.timer=undefined}socketTokens.delete(socket.id)});
});
server.listen(port,()=>console.log(`五行転輪 server listening on port ${port}`));