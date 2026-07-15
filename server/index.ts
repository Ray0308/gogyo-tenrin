import express from "express";
import { beginShikigamiAction, canCounterCardAttack, hasSelectableAttackUnit, isSelectableAttackUnit, randomAttackCandidates, reduceUnitDamage } from "./combat-rules.js";
import { perspectiveLog } from "./perspective.js";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  ATTRIBUTE_GENERATION_MP,
  ATTRIBUTE_MATCH_BONUS,
  ATTRIBUTE_OVERCOME_BONUS,
  INITIAL_PLAYER_HP,
  INITIAL_PLAYER_MP,
  MAX_PLAYER_HP,
  MAX_PLAYER_MP,
} from "../shared/game-balance.js";
import {
  FIVE_ELEMENTS,
  type BattlePlayerState,
  type CardCatalogItem,
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

interface CardMaster { id:string; name:string; category:string; system:string; attribute:string; templateId:string|null; cost:number; mpCost:number; weight:number; target:string; timing:string; effectText:string; description:string; flavorText:string; imageId?:string; timings:string[]; effects:CardEffectDefinition[] }
interface IdMaster { id:string; score?:number|string }
interface DataManifest { schemaVersion:string; dataVersion:string; files:Record<string,{filename:string;count:number}> }
interface ShikigamiMaster { id:string; name:string; attribute:string; maxHp:number; attack:number; aiProfile:string; keywords:string|null; keywordIds:string[]; ability:string; description:string; imageId:string }
interface FieldMaster { id:string; name:string; attribute:string; effectText:string; triggerCount?:number|null }
type AttributeMatchEffect =
  | { type:"apply_curse"; curseId:"curse_poison"|"curse_burn"; stacks:number }
  | { type:"next_damage_reduction"; amount:number }
  | { type:"ignore_damage_reduction"; amount:number }
  | { type:"gain_mp"; amount:number };
interface AttackDefinition { type:"attack"; cardId:string; target:"opponent_any"|"opponent_unit"|"opponent_random_unit"|"opponent_units"; baseDamage:number; ignoreTaunt?:boolean; healSelf?:number; attributeMatchEffect?:AttributeMatchEffect }
interface TurnDefinition { type:"turn"; cardId:string; target:"self_player"; steps:number }
interface SummonDefinition { type:"summon"; cardId:string; target:"self_field"; shikigamiId:string }
interface FieldDefinition { type:"barrier"|"terrain"; cardId:string; target:"self_field"|"shared_field"; fieldId:string }
interface DefenseDefinition { type:"defense"; cardId:string; scope:"single"|"all"; mode:"reduce"|"nullify"; amount:number; postEffect?:"heal"|"retaliate"|"gain_mp"|"next_reduction"|"heal_lowest_damaged"; allowEffectDamage?:boolean }
interface CleanseDefinition { type:"cleanse"; cardId:string; target:"self_or_ally_unit"; amount:number }
interface RestoreDefinition { type:"restore"; cardId:string; target:"self_player"; hp:number; mp:number }
interface SealDefinition { type:"seal"; cardId:string; target:"opponent_unit_or_barrier" }
interface CleanseAllDefinition { type:"cleanse_all_units"; cardId:string; target:"all_units"; amount:number }
interface TurnChoiceDefinition { type:"turn_choice"; cardId:string; target:"self_player"; steps:number[] }
interface GenerateDefinition { type:"generate"; cardId:string; target:"self_player"; requiredAttribute:FiveElement; successMp:number; failureMp:number; steps:number }
interface CycleDefinition { type:"cycle"|"cycle_choice"; cardId:string; target:"self_player"; steps:number|number[]; draw:number; discard:number }
interface ReviveDefinition { type:"revive"; cardId:string; target:"retired_ally_unit"; hpRatio:number; canActThisTurn:boolean }
interface ClearFieldsDefinition { type:"clear_fields"; cardId:string; target:"all"; barriers:boolean; terrain:boolean }
interface SacrificeDefinition { type:"sacrifice"; cardId:string; target:"ally_unit"; heal:number; mp:number }
interface ChooseTerrainDefinition { type:"choose_terrain"; cardId:string; target:"shared_field" }
interface BuffUnitDefinition { type:"buff_unit"; cardId:string; target:"ally_unit"; maxHp:number; hp:number; attack:number }
type CardEffectDefinition = AttackDefinition|TurnDefinition|SummonDefinition|DefenseDefinition|FieldDefinition|CleanseDefinition|RestoreDefinition|SealDefinition|CleanseAllDefinition|TurnChoiceDefinition|GenerateDefinition|CycleDefinition|ReviveDefinition|ClearFieldsDefinition|SacrificeDefinition|ChooseTerrainDefinition|BuffUnitDefinition;
interface PendingReaction {
  defenderSide:Side; eligibleCardIds:string[]; remainingMs:number; timer?:ReturnType<typeof setTimeout>;
  pausedTurnSide?:Side; pausedTurnRemainingMs?:number;
  targets:{id:DefenseTarget;target:UnitTarget;predictedDamage:number}[];
  resolve:(definition?:DefenseDefinition,target?:DefenseTarget)=>void;
}
interface StoredSession { state:SessionState; mode?:"cpu"|"online"; roomId?:string; hostToken?:string; guestToken?:string; hostName?:string; guestName?:string; cpuHand:CardView[]; cpuDiscard:CardView[]; pendingReaction?:PendingReaction; cpuCardActions:number; cpuShikigamiQueue?:string[]; cpuStartTimer?:ReturnType<typeof setTimeout>; turnTimer?:ReturnType<typeof setTimeout>; attributeTimer?:ReturnType<typeof setTimeout>; reconnectTimer?:ReturnType<typeof setTimeout>; turnRemainingMs?:number; disconnectedAt?:number; onlineShikigamiQueue?:string[]; onlineTurnSide?:Side; disconnectedTokens?:Set<string>; onlineReconnectTimers?:Map<string,ReturnType<typeof setTimeout>>; rematchVotes?:Set<Side>; rematchTimer?:ReturnType<typeof setTimeout> }
type Side = "player"|"cpu";
type UnitTarget = { type:"player" }|{ type:"unit"; unit:ShikigamiState };
type AttackSource = { type:"player" }|{ type:"unit"; unit:ShikigamiState };

const app=express();
export const server=createServer(app);
export const io=new Server<ClientToServerEvents,ServerToClientEvents>(server);
const port=Number(process.env.PORT??3000);
const CPU_TURN_START_DELAY_MS=Number(process.env.CPU_TURN_START_DELAY_MS??1_800);
const currentDirectory=path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory=path.resolve(currentDirectory,"..");
const clientDirectory=path.join(distributionDirectory,"client");
const rootDocument=readFileSync(path.join(clientDirectory,"index.html"),"utf8");
const manifest=loadJson<DataManifest>("manifest.json");
const cards=loadJson<CardMaster[]>("cards.json");
const cardTemplates=loadJson<IdMaster[]>("cardTemplates.json");
const shikigami=loadJson<ShikigamiMaster[]>("shikigami.json");
const barriers=loadJson<FieldMaster[]>("barriers.json");
const terrains=loadJson<FieldMaster[]>("terrains.json");
const forbiddenArts=loadJson<IdMaster[]>("forbiddenArts.json");
const keywords=loadJson<IdMaster[]>("keywords.json");
const curses=loadJson<IdMaster[]>("curses.json");
const aiScores=loadJson<IdMaster[]>("aiScores.json");
const definitions=cards.flatMap(card=>card.effects);
const cardById=new Map(cards.map(card=>[card.id,card]));
const shikigamiById=new Map(shikigami.map(unit=>[unit.id,unit]));
const barrierById=new Map(barriers.map(field=>[field.id,field]));
const terrainById=new Map(terrains.map(field=>[field.id,field]));
const effectByCardId=new Map(definitions.map(effect=>[effect.cardId,effect]));
const totalCardWeight=cards.reduce((sum,card)=>sum+card.weight,0);
const publicCardCatalog:CardCatalogItem[]=cards.map(card=>({cardId:card.id,name:card.name,category:card.category,system:card.system,attribute:card.attribute,cost:card.cost,mpCost:card.mpCost,target:card.target,timing:card.timing,effectText:card.effectText,description:card.description,flavorText:card.flavorText}));
const sessions=new Map<string,StoredSession>();
const socketTokens=new Map<string,string>();
const cardAttributeToElement:Record<string,FiveElement|undefined>={"木":"wood","火":"fire","土":"earth","金":"metal","水":"water"};
const elementName:Record<FiveElement,string>={wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};
const generates:Record<FiveElement,FiveElement>={wood:"fire",fire:"earth",earth:"metal",metal:"water",water:"wood"};
const overcomes:Record<FiveElement,FiveElement>={wood:"earth",earth:"water",water:"fire",fire:"metal",metal:"wood"};

function loadJson<T>(name:string):T{return JSON.parse(readFileSync(path.join(currentDirectory,"data",name),"utf8")) as T}
function validateMaster():void{
  if(manifest.schemaVersion!=="1.0.0"||manifest.dataVersion!=="0.3.0")throw new Error("Master data version mismatch.");
  const collections:Record<string,IdMaster[]>={cards,cardTemplates,shikigami,barriers,terrains,forbiddenArts,keywords,curses,aiScores};
  const filenames:Record<string,string>={cards:"cards.json",cardTemplates:"cardTemplates.json",shikigami:"shikigami.json",barriers:"barriers.json",terrains:"terrains.json",forbiddenArts:"forbiddenArts.json",keywords:"keywords.json",curses:"curses.json",aiScores:"aiScores.json"};
  const ids=new Set<string>();
  for(const [key,items] of Object.entries(collections)){
    const entry=manifest.files[key];
    if(!entry||entry.filename!==filenames[key]||entry.count!==items.length)throw new Error(`Master manifest mismatch: ${key}`);
    for(const item of items){if(!/^[a-z0-9_]+$/.test(item.id)||ids.has(item.id))throw new Error(`Invalid or duplicate master ID: ${item.id}`);ids.add(item.id)}
  }
  if(cards.length===0||totalCardWeight<=0)throw new Error("No drawable cards are configured.");
  const templateIds=new Set(cardTemplates.map(item=>item.id));
  const keywordIds=new Set(keywords.map(item=>item.id));
  const curseIds=new Set(curses.map(item=>item.id));
  for(const card of cards){
    if(card.cost<0||card.mpCost<0||card.weight<0||!Array.isArray(card.timings)||!Array.isArray(card.effects))throw new Error(`Invalid card master: ${card.id}`);
    if(card.templateId&&!templateIds.has(card.templateId))throw new Error(`Unknown card template: ${card.templateId}`);
  }
  for(const unit of shikigami){if(!Array.isArray(unit.keywordIds)||unit.keywordIds.some(id=>!keywordIds.has(id)))throw new Error(`Invalid shikigami keyword reference: ${unit.id}`)}
  for(const definition of definitions){
    if(!cardById.has(definition.cardId))throw new Error(`Unknown effect card: ${definition.cardId}`);
    if(definition.type==="summon"&&!shikigamiById.has(definition.shikigamiId))throw new Error(`Unknown shikigami: ${definition.shikigamiId}`);
    if(definition.type==="barrier"&&!barrierById.has(definition.fieldId))throw new Error(`Unknown barrier: ${definition.fieldId}`);
    if(definition.type==="terrain"&&!terrainById.has(definition.fieldId))throw new Error(`Unknown terrain: ${definition.fieldId}`);
    const curseId=definition.type==="attack"&&definition.attributeMatchEffect?.type==="apply_curse"?definition.attributeMatchEffect.curseId:undefined;
    if(curseId&&!curseIds.has(curseId))throw new Error(`Unknown curse: ${curseId}`);
  }
}
validateMaster();

function publicState(state:SessionState):SessionState{return structuredClone(state)}

interface OnlineRoom { id:string; session:StoredSession; hostToken:string; guestToken?:string }
const rooms=new Map<string,OnlineRoom>();
const tokenSides=new Map<string,Side>();
function sideForSocket(socketId:string):Side{const token=socketTokens.get(socketId);return tokenSides.get(token??"")??"player"}
function publicStateForToken(session:StoredSession,token:string):SessionState{
  const result=publicState(session.state);result.reconnectToken=token;
  if(result.mode!=="online")return result;
  const side=tokenSides.get(token)??"player";result.role=side==="player"?"host":"guest";
  result.playerName=side==="player"?session.hostName:session.guestName;result.opponentName=side==="player"?session.guestName:session.hostName;
  result.roomReady=Boolean(session.guestToken);result.roomId=session.roomId;
  if(result.phase==="attribute_selection"){if(side==="player")result.cpuAttribute=undefined;else result.playerAttribute=undefined}
  if(result.battle)result.battle.log=result.battle.log.map((entry)=>perspectiveLog(entry,side));
  if(side==="cpu"){
    const playerAttribute=result.playerAttribute;result.playerAttribute=result.cpuAttribute;result.cpuAttribute=playerAttribute;
    if(result.battle){
      const battle=result.battle,hostPlayer=battle.player,guestPlayer=battle.cpu,guestHand=structuredClone(session.cpuHand);
      result.battle={
        ...battle,
        activePlayer:battle.activePlayer==="player"?"cpu":"player",
        winner:battle.winner?battle.winner==="player"?"cpu":"player":undefined,
        player:{...guestPlayer,hand:guestHand,discard:structuredClone(session.cpuDiscard)},
        cpu:{
          hp:hostPlayer.hp,
          mp:hostPlayer.mp,
          cost:hostPlayer.cost,
          curses:structuredClone(hostPlayer.curses),
          nextDamageReduction:hostPlayer.nextDamageReduction,
          shikigami:structuredClone(hostPlayer.shikigami),
          barrier:hostPlayer.barrier?structuredClone(hostPlayer.barrier):undefined,
          retiredShikigami:structuredClone(hostPlayer.retiredShikigami),
          handCount:hostPlayer.hand.length,
        },
      };
      decorateHand(result,"player",result.battle.player.hand);
    }
  }
  return result;
}
function publicStateForSocket(socketId:string,session:StoredSession):SessionState{const token=socketTokens.get(socketId)??session.hostToken??session.state.reconnectToken??"";return publicStateForToken(session,token)}
function sendSessionToSocket(socketId:string,session:StoredSession):void{io.to(socketId).emit("session:state",publicStateForSocket(socketId,session))}

function currentSession(socketId:string):StoredSession|undefined{const token=socketTokens.get(socketId);return token?sessions.get(token):undefined}
function sendState(socketId:string,state:SessionState):void{io.to(socketId).emit("session:state",publicState(state))}
function sendSessionState(session:StoredSession):void{for(const [socketId,token] of socketTokens){if(sessions.get(token)===session)sendSessionToSocket(socketId,session)}}
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
function refreshTurnHand(session:StoredSession,side:Side,count=5):void{
  const hand=handForSide(session,side),discard=discardForSide(session,side),drawCount=Math.min(7,Math.max(0,count));
  for(const card of hand){card.playable=false;card.unusableReason="Turn-start hand replacement.";card.playTarget=undefined;discard.push(card)}
  hand.splice(0,hand.length,...drawCards(drawCount));
  if(side==="cpu")session.state.battle!.cpu.handCount=hand.length;
  session.state.battle!.log.push(`${side==="player"?"Player":"CPU"} replaced the hand and drew ${drawCount} cards.`);
}
function expectedPlayerTarget(definition:CardEffectDefinition):CardPlayTarget{
  if(definition.type==="attack"){if(definition.target==="opponent_any")return "cpu_any";if(definition.target==="opponent_unit")return "cpu_unit";return "cpu_field"}
  if(definition.type==="terrain"||definition.type==="choose_terrain")return "shared_field";
  if(definition.type==="seal")return "cpu_unit";
  if(definition.type==="cleanse"||definition.type==="sacrifice"||definition.type==="buff_unit")return "player_unit";
  if(definition.type==="revive")return "retired_unit";
  if(definition.type==="summon"||definition.type==="barrier")return "player_field";
  return "player";
}
function isDefinitionUsable(state:SessionState,side:Side,card:CardView,definition:CardEffectDefinition):string|undefined{
  const actor=stateForSide(state,side),opponent=stateForSide(state,otherSide(side));
  if(actor.cost<card.cost)return "Not enough cost.";
  if(actor.mp<card.mpCost)return "Not enough MP.";
  if(actor.curses.some(curse=>curse.id==="curse_silence")&&card.category==="\u8853\u672d")return "Spell cards cannot be used while silenced.";
  if(definition.type==="summon"&&actor.shikigami.length>=3)return "The shikigami field is full.";
  if(definition.type==="revive"&&(actor.shikigami.length>=3||actor.retiredShikigami.length===0))return "No retired shikigami can be revived.";
  if((definition.type==="sacrifice"||definition.type==="buff_unit")&&actor.shikigami.length===0)return "No allied shikigami is available.";
  if(definition.type==="cleanse"&&!actor.curses.length&&!actor.shikigami.some(unit=>unit.curses.length))return "There is no curse to remove.";
  if(definition.type==="seal"&&!opponent.shikigami.length&&!opponent.barrier)return "There is no valid seal target.";
  if(definition.type==="attack"&&(definition.target==="opponent_units"||definition.target==="opponent_random_unit")&&opponent.shikigami.length===0)return "攻撃対象となる相手式神がいません。";
  if(definition.type==="attack"&&definition.target==="opponent_unit"&&!hasSelectableAttackUnit(opponent.shikigami,Boolean(definition.ignoreTaunt)))return "ステルスまたは挑発により選択可能な相手式神がいません。";
  return undefined;
}
function decorateHand(state:SessionState,side:Side,hand:CardView[]):void{
  const battle=state.battle;if(!battle)return;
  for(const card of hand){card.playTarget=undefined;card.ignoreTaunt=undefined;card.choiceOptions=undefined;const definition=effectByCardId.get(card.cardId);
    if(battle.phase==="reaction"){card.playable=Boolean(battle.reaction?.eligibleCardIds.includes(card.instanceId));card.unusableReason=card.playable?undefined:"This card cannot be used for the current reaction."}
    else if(battle.phase!=="card_use"||battle.activePlayer!==side){card.playable=false;card.unusableReason="Cards cannot be used now."}
    else if(!definition||definition.type==="defense"){card.playable=false;card.unusableReason=definition?.type==="defense"?"Defense cards are used during a reaction window.":"No structured effect is connected."}
    else{const reason=isDefinitionUsable(state,side,card,definition);card.playable=!reason;card.unusableReason=reason;card.playTarget=expectedPlayerTarget(definition);card.ignoreTaunt=definition.type==="attack"&&definition.ignoreTaunt;if(definition.type==="turn_choice"||definition.type==="cycle_choice")card.choiceOptions=[{value:"1",label:"Forward 1"},{value:"-1",label:"Reverse 1"}];if(definition.type==="choose_terrain")card.choiceOptions=terrains.map(item=>({value:item.id,label:item.name}))}
  }
}
function refreshPlayability(state:SessionState):void{const battle=state.battle;if(battle)decorateHand(state,"player",battle.player.hand)}
function addCurse(curseStates:CurseState[],curseId:string,stacks=1):void{
  const config:Record<string,{name:string;stackable:boolean;remaining?:number}>={
    curse_poison:{name:"\u6bd2",stackable:true},curse_burn:{name:"\u706b\u50b7",stackable:false,remaining:2},
    curse_freeze:{name:"\u51cd\u7d50",stackable:false,remaining:1},curse_paralysis:{name:"\u9ebb\u75fa",stackable:false,remaining:2},
    curse_silence:{name:"\u6c88\u9ed9",stackable:false,remaining:1},curse_binding:{name:"\u546a\u7e1b",stackable:false,remaining:1}
  };
  const rule=config[curseId];if(!rule)return;const existing=curseStates.find(curse=>curse.id===curseId);
  if(curseId==="curse_poison"){if(existing)existing.stacks=Math.min(5,existing.stacks+stacks);else curseStates.push({id:curseId,name:rule.name,stacks:Math.min(5,stacks)});return}
  if(existing){existing.stacks=1;existing.remainingTriggers=Math.max(existing.remainingTriggers??0,rule.remaining??1)}
  else curseStates.push({id:curseId,name:rule.name,stacks:1,remainingTriggers:rule.remaining});
}
function finishIfNeeded(state:SessionState):boolean{
  const battle=state.battle!;if(battle.player.hp<=0){battle.phase="finished";battle.winner="cpu";battle.log.push("プレイヤーのHPが0になり、CPUが勝利した。");return true}
  if(battle.cpu.hp<=0){battle.phase="finished";battle.winner="player";battle.log.push("CPUのHPが0になり、プレイヤーが勝利した。");return true}return false;
}
function applyDamageToPlayer(state:SessionState,side:Side,amount:number,ignoreReduction=0,curseDamage=false):number{
  const target=stateForSide(state,side),barrierReduction=!curseDamage&&target.barrier?.id==="barrier_guardian"?1:0,reduction=Math.max(0,target.nextDamageReduction+barrierReduction-ignoreReduction),damage=Math.max(0,amount-reduction);if(target.nextDamageReduction>0)target.nextDamageReduction=0;target.hp=Math.max(0,target.hp-damage);return damage;
}
function applyDamageToUnit(state:SessionState,unit:ShikigamiState,amount:number,ignoreReduction=0):number{const terrainReduction=state.battle?.terrain?.id==="terrain_sacred_domain"?1:0,damage=reduceUnitDamage(amount,unit,terrainReduction,ignoreReduction);unit.hp=Math.max(0,unit.hp-damage);return damage}
function cleanupUnits(state:SessionState,side:Side):void{const owner=stateForSide(state,side),dead=owner.shikigami.filter(unit=>unit.hp<=0);for(const unit of dead){state.battle!.log.push(`${unit.name} retired.`);owner.retiredShikigami.push({...structuredClone(unit),curses:[],nextDamageReduction:0,shellDamageReduction:0,nextAttackBonus:0});if(state.battle!.terrain?.id==="terrain_yomi_road"){owner.mp=Math.min(MAX_PLAYER_MP,owner.mp+1);state.battle!.log.push(`Yomi Road granted ${side==="player"?"Player":"CPU"} 1 MP.`)}}owner.shikigami=owner.shikigami.filter(unit=>unit.hp>0)}
function applyTargetCurse(state:SessionState,side:Side,target:UnitTarget,effect:AttributeMatchEffect):void{
  if(effect.type!=="apply_curse")return;const curses=target.type==="player"?stateForSide(state,otherSide(side)).curses:target.unit.curses;addCurse(curses,effect.curseId,effect.stacks);state.battle!.log.push(`${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}に呪い：${effect.curseId==="curse_poison"?"毒":"火傷"}を付与した。`);
}
function applySelfMatchEffect(state:SessionState,side:Side,effect:AttributeMatchEffect|undefined):number{
  if(!effect||effect.type==="apply_curse")return 0;const battle=state.battle!,actor=stateForSide(state,side);
  if(effect.type==="next_damage_reduction"){actor.nextDamageReduction=Math.max(actor.nextDamageReduction,effect.amount);battle.log.push(`次に受けるダメージを${effect.amount}軽減する効果を得た。`)}
  else if(effect.type==="ignore_damage_reduction"){battle.log.push(`この攻撃はダメージ軽減を${effect.amount}無視する。`);return effect.amount}
  else{actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+effect.amount);battle.log.push(`属性固有効果でMPが${effect.amount}増加した。`)}
  return 0;
}
function findUnitTarget(state:SessionState,side:Side,target:CardTarget|undefined):ShikigamiState|undefined{
  if(!target||!target.startsWith("cpu_unit:"))return undefined;return stateForSide(state,otherSide(side)).shikigami.find(unit=>unit.instanceId===target.slice("cpu_unit:".length));
}
function findAllyUnitTarget(state:SessionState,side:Side,target:CardTarget|undefined):ShikigamiState|undefined{
  if(!target)return undefined;const prefix=state.mode==="online"?"player_unit:":side==="player"?"player_unit:":"cpu_unit:";if(!target.startsWith(prefix))return undefined;
  return stateForSide(state,side).shikigami.find(unit=>unit.instanceId===target.slice(prefix.length));
}
function findRetiredTarget(state:SessionState,side:Side,target:CardTarget|undefined):ShikigamiState|undefined{
  if(!target?.startsWith("retired_unit:"))return undefined;return stateForSide(state,side).retiredShikigami.find(unit=>unit.instanceId===target.slice("retired_unit:".length));
}
function validateUtilityTarget(state:SessionState,side:Side,definition:CardEffectDefinition,target:CardTarget|undefined,choice?:string):boolean{
  if(side==="cpu"&&state.mode!=="online")return true;
  if(definition.type==="cleanse"){if(target==="player")return stateForSide(state,side).curses.length>0;const unit=findAllyUnitTarget(state,side,target);return Boolean(unit?.curses.length)}
  if(definition.type==="seal"){if(target==="cpu_barrier")return Boolean(stateForSide(state,otherSide(side)).barrier);return Boolean(findUnitTarget(state,side,target))}
  if(definition.type==="sacrifice"||definition.type==="buff_unit")return Boolean(findAllyUnitTarget(state,side,target));
  if(definition.type==="revive")return Boolean(findRetiredTarget(state,side,target));
  if(definition.type==="turn_choice"||definition.type==="cycle_choice")return target==="player"&&Array.isArray(definition.steps)&&definition.steps.includes(Number(choice));
  if(definition.type==="choose_terrain")return target==="shared_field"&&Boolean(choice&&terrainById.has(choice));
  return target===expectedPlayerTarget(definition);
}
function validUnitAttackTarget(state:SessionState,side:Side,definition:AttackDefinition,unit:ShikigamiState):boolean{
  const units=stateForSide(state,otherSide(side)).shikigami;
  return isSelectableAttackUnit(units,unit,Boolean(definition.ignoreTaunt));
}
function validateAttackTarget(state:SessionState,side:Side,definition:AttackDefinition,target:CardTarget|undefined):boolean{
  if(side==="cpu"&&state.mode!=="online")return true;if(definition.target==="opponent_units"||definition.target==="opponent_random_unit")return target==="cpu_field";
  if(target==="cpu_player")return definition.target==="opponent_any"&&(Boolean(definition.ignoreTaunt)||!stateForSide(state,otherSide(side)).shikigami.some(unit=>unit.keywords.includes("挑発")));
  const unit=findUnitTarget(state,side,target);return Boolean(unit&&validUnitAttackTarget(state,side,definition,unit));
}
function attackTargets(state:SessionState,side:Side,definition:AttackDefinition,target:CardTarget|undefined):UnitTarget[]{
  const opponent=stateForSide(state,otherSide(side));if(definition.target==="opponent_units")return opponent.shikigami.map(unit=>({type:"unit",unit}));
  if(definition.target==="opponent_random_unit"){const candidates=randomAttackCandidates(opponent.shikigami),unit=candidates[randomInt(candidates.length)];return unit?[{type:"unit",unit}]:[]}
  if(side==="player"||state.mode==="online"){if(target==="cpu_player")return [{type:"player"}];const unit=findUnitTarget(state,side,target);return unit?[{type:"unit",unit}]:[]}
  let units=opponent.shikigami.filter(unit=>validUnitAttackTarget(state,side,definition,unit));const taunts=units.filter(unit=>unit.keywords.includes("挑発"));
  if(!definition.ignoreTaunt&&taunts.length)units=taunts;
  if(definition.target==="opponent_unit"||(!definition.ignoreTaunt&&taunts.length))return units.length?[{type:"unit",unit:units[randomInt(units.length)]}]:[];
  return [{type:"player"}];
}function triggerBurnAfterCard(state:SessionState,side:Side):void{
  const actor=stateForSide(state,side),burn=actor.curses.find(curse=>curse.id==="curse_burn");if(!burn)return;
  const damage=applyDamageToPlayer(state,side,1,0,true);state.battle!.log.push(`火傷により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`);burn.remainingTriggers=(burn.remainingTriggers??2)-1;if(burn.remainingTriggers<=0)actor.curses=actor.curses.filter(curse=>curse!==burn);
}
function createShikigami(master:ShikigamiMaster):ShikigamiState{return {instanceId:randomUUID(),shikigamiId:master.id,imageId:master.imageId,name:master.name,attribute:master.attribute,hp:master.maxHp,maxHp:master.maxHp,attack:master.attack,aiProfile:master.aiProfile,keywords:master.keywords?master.keywords.split(/[・、,]/).filter(Boolean):[],ability:master.ability,curses:[],nextDamageReduction:0,shellDamageReduction:0,nextAttackBonus:0,cannotActTurn:undefined,abilityDisabledUntilTurn:undefined}}
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
  if(definition.postEffect==="heal"&&protectedTargets[0]){const target=protectedTargets[0];if(target.type==="player")defender.hp=Math.min(MAX_PLAYER_HP,defender.hp+1);else target.unit.hp=Math.min(target.unit.maxHp,target.unit.hp+1);battle.log.push(`${defenseTargetLabel(target)}のHPが1回復した。`)}
  else if(definition.postEffect==="heal_lowest_damaged"&&damagedTargets.length){const sorted=[...damagedTargets].sort((a,b)=>{const ar=a.type==="player"?defender.hp/MAX_PLAYER_HP:a.unit.hp/a.unit.maxHp,br=b.type==="player"?defender.hp/MAX_PLAYER_HP:b.unit.hp/b.unit.maxHp;return ar-br});const target=sorted[0];if(target.type==="player")defender.hp=Math.min(MAX_PLAYER_HP,defender.hp+1);else target.unit.hp=Math.min(target.unit.maxHp,target.unit.hp+1);battle.log.push(`${defenseTargetLabel(target)}のHPが1回復した。`)}
  else if(definition.postEffect==="gain_mp"){defender.mp=Math.min(MAX_PLAYER_MP,defender.mp+1);battle.log.push(`${defenderSide==="player"?"プレイヤー":"CPU"}のMPが1増加した。`)}
  else if(definition.postEffect==="next_reduction"&&protectedTargets[0]){const target=protectedTargets[0];if(target.type==="player")defender.nextDamageReduction=Math.max(defender.nextDamageReduction,1);else target.unit.nextDamageReduction=Math.max(target.unit.nextDamageReduction,1);battle.log.push(`${defenseTargetLabel(target)}は次に受けるダメージを1軽減する。`)}
  else if(definition.postEffect==="retaliate"&&prevented>0){const damage=source.type==="player"?applyDamageToPlayer(state,attackerSide,1):applyDamageToUnit(state,source.unit,1);battle.log.push(`防御札の反撃により${source.type==="player"?(attackerSide==="player"?"プレイヤー":"CPU"):source.unit.name}へ${damage}ダメージ。`)}
}
function resolveCardAttack(state:SessionState,side:Side,card:CardView,definition:AttackDefinition,targets:UnitTarget[],cardElement:FiveElement,match:boolean,ignore:number,defense?:DefenseDefinition,selectedTarget?:DefenseTarget):void{
  const battle=state.battle!,defenderSide=otherSide(side),protectedTargets=defense?(defense.scope==="all"?targets:targets.filter(target=>defenseTargetId(target)===selectedTarget)):[],damagedTargets:UnitTarget[]=[];let prevented=0;
  for(const target of targets){const targetElement=targetAttribute(state,side,target),overcoming=Boolean(targetElement&&overcomes[cardElement]===targetElement),raw=definition.baseDamage+(match?ATTRIBUTE_MATCH_BONUS:0)+(overcoming?ATTRIBUTE_OVERCOME_BONUS:0),protectedTarget=protectedTargets.includes(target),adjusted=protectedTarget?(defense!.mode==="nullify"?0:Math.max(0,raw-defense!.amount)):raw;prevented+=raw-adjusted;const damage=target.type==="player"?applyDamageToPlayer(state,defenderSide,adjusted,ignore):applyDamageToUnit(state,target.unit,adjusted,ignore);if(damage>0)damagedTargets.push(target);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用し、${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}へ${damage}ダメージ。`);if(match&&definition.attributeMatchEffect)applyTargetCurse(state,side,target,definition.attributeMatchEffect);if(overcoming)battle.log.push(`相剋成立：ダメージに＋${ATTRIBUTE_OVERCOME_BONUS}。`);}
  if(match)battle.log.push(`属性一致：基本効果量に＋${ATTRIBUTE_MATCH_BONUS}。`);
  if(definition.healSelf)stateForSide(state,side).hp=Math.min(MAX_PLAYER_HP,stateForSide(state,side).hp+definition.healSelf);
  if(defense)applyDefensePostEffect(state,defenderSide,defense,protectedTargets,damagedTargets,prevented,side);
  cleanupUnits(state,defenderSide);cleanupUnits(state,side);
  for(const target of damagedTargets){
    if(target.type!=="unit"||!canCounterCardAttack(true,target.unit.hp,stateForSide(state,side).hp,target.unit.keywords))continue;
    const damage=applyDamageToPlayer(state,side,1);
    battle.log.push(`${target.unit.name} countered the attacking player for ${damage} damage.`);
    cleanupUnits(state,side);
  }
}
function armReactionTimer(session:StoredSession,pending:PendingReaction):void{const battle=session.state.battle!;const duration=Math.max(0,pending.remainingMs);if(battle.reaction)battle.reaction.deadline=Date.now()+duration;pending.timer=setTimeout(()=>{if(session.pendingReaction!==pending)return;battle.log.push("反応受付が時間切れとなった。");finishReaction(session,pending.defenderSide);sendSessionState(session)},duration)}
function beginReaction(session:StoredSession,defenderSide:Side,sourceName:string,attackerName:string,targets:UnitTarget[],predictions:number[],resolve:(definition?:DefenseDefinition,target?:DefenseTarget)=>void):void{
  const battle=session.state.battle!,eligible=defenseCards(session,defenderSide);
  const pausedTurnSide=session.mode==="online"&&session.turnTimer?battle.activePlayer:undefined;
  const pausedTurnRemainingMs=pausedTurnSide&&battle.turnDeadline?Math.max(0,battle.turnDeadline-Date.now()):undefined;
  if(pausedTurnSide)clearTurnTimer(session);
  battle.phase="reaction";battle.log.push(`${sourceName}に対する反応受付を開始した。`);battle.reaction={sourceName,attackerName,targets:targets.map((target,index)=>({id:defenseTargetId(target),label:defenseTargetLabel(target),predictedDamage:predictions[index]})),eligibleCardIds:eligible.map(item=>item.card.instanceId),deadline:Date.now()+10_000};const pending:PendingReaction={defenderSide,eligibleCardIds:battle.reaction.eligibleCardIds,remainingMs:10_000,pausedTurnSide,pausedTurnRemainingMs,targets:targets.map((target,index)=>({id:defenseTargetId(target),target,predictedDamage:predictions[index]})),resolve};session.pendingReaction=pending;armReactionTimer(session,pending);refreshPlayability(session.state);
}
function finishReaction(session:StoredSession,respondingSide:Side,instanceId?:string,targetId?:DefenseTarget):{ok:boolean;message?:string}{
  const pending=session.pendingReaction,battle=session.state.battle;if(!pending||pending.defenderSide!==respondingSide||!battle||battle.phase!=="reaction")return {ok:false,message:"現在は反応受付中ではありません。"};let definition:DefenseDefinition|undefined;
  if(instanceId){if(!pending.eligibleCardIds.includes(instanceId))return {ok:false,message:"この防御札は使用できません。"};const hand=handForSide(session,respondingSide),index=hand.findIndex(card=>card.instanceId===instanceId);const card=hand[index],effect=card?effectByCardId.get(card.cardId):undefined;if(!card||effect?.type!=="defense")return {ok:false,message:"防御札が見つかりません。"};if(effect.scope==="single"){if(pending.targets.length===1)targetId=pending.targets[0].id;if(!targetId||!pending.targets.some(target=>target.id===targetId))return {ok:false,message:"防御する対象を選択してください。"}}stateForSide(session.state,respondingSide).mp-=card.mpCost;consumeUsedCard(session,respondingSide,index);definition=effect;battle.log.push(`${respondingSide==="player"?"プレイヤー":"CPU"}が防御札 ${card.name}を使用した。`)}else battle.log.push(`${respondingSide==="player"?"プレイヤー":"CPU"}は防御札を使用しなかった。`);
  if(pending.timer)clearTimeout(pending.timer);delete session.pendingReaction;delete battle.reaction;pending.resolve(definition,targetId);if(session.mode==="online"&&battle.phase==="reaction")battle.phase="card_use";
  if(session.mode==="online"&&pending.pausedTurnSide===battle.activePlayer&&battle.phase==="card_use"&&!session.state.connectionPaused)armOnlineTurnTimer(session,pending.pausedTurnRemainingMs??60_000);
  return {ok:true};
}

function rotateAttribute(state:SessionState,side:Side,steps:number):void{
  const current=attributeForSide(state,side),index=FIVE_ELEMENTS.indexOf(current),next=FIVE_ELEMENTS[(index+(steps%5)+5)%5];
  setAttributeForSide(state,side,next);state.battle!.log.push(`${side==="player"?"Player":"CPU"} rotated ${elementName[current]} to ${elementName[next]}.`);
}
function resolveUtilityCard(session:StoredSession,side:Side,definition:Exclude<CardEffectDefinition,AttackDefinition|DefenseDefinition>,target:CardTarget|undefined,choice?:string):void{
  const state=session.state,battle=state.battle!,actor=stateForSide(state,side),opponent=stateForSide(state,otherSide(side)),manual=side==="player"||state.mode==="online";
  if(definition.type==="turn")rotateAttribute(state,side,definition.steps);
  else if(definition.type==="turn_choice")rotateAttribute(state,side,Number(choice));
  else if(definition.type==="generate"){if(attributeForSide(state,side)===definition.requiredAttribute){actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+definition.successMp);rotateAttribute(state,side,definition.steps)}else actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+definition.failureMp)}
  else if(definition.type==="cycle")rotateAttribute(state,side,Number(definition.steps));
  else if(definition.type==="cycle_choice")rotateAttribute(state,side,Number(choice));
  else if(definition.type==="cleanse"){const unit=manual?findAllyUnitTarget(state,side,target):actor.shikigami.find(item=>item.curses.length);removeOneCurse(unit?.curses??actor.curses)}
  else if(definition.type==="restore"){actor.hp=Math.min(MAX_PLAYER_HP,actor.hp+definition.hp);actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+definition.mp)}
  else if(definition.type==="seal"){const unit=manual?findUnitTarget(state,side,target):opponent.shikigami[0];if(unit)unit.abilityDisabledUntilTurn=battle.turnNumber+(side==="cpu"?1:0);else if(opponent.barrier)opponent.barrier.skipNextTrigger=true}
  else if(definition.type==="cleanse_all_units"){for(const owner of [battle.player,battle.cpu])for(const unit of owner.shikigami)removeOneCurse(unit.curses)}
  else if(definition.type==="summon"){actor.shikigami.push(createShikigami(shikigamiById.get(definition.shikigamiId)!))}
  else if(definition.type==="barrier"){actor.barrier=createFieldState(barrierById.get(definition.fieldId)!)}
  else if(definition.type==="terrain"){battle.terrain=createFieldState(terrainById.get(definition.fieldId)!)}
  else if(definition.type==="revive"){const retired=manual?findRetiredTarget(state,side,target):actor.retiredShikigami[0];if(retired){actor.retiredShikigami=actor.retiredShikigami.filter(unit=>unit.instanceId!==retired.instanceId);actor.shikigami.push({...structuredClone(retired),instanceId:randomUUID(),hp:Math.ceil(retired.maxHp*definition.hpRatio),curses:[],nextDamageReduction:0,shellDamageReduction:0,nextAttackBonus:0,cannotActTurn:battle.turnNumber})}}
  else if(definition.type==="clear_fields"){if(definition.barriers){delete battle.player.barrier;delete battle.cpu.barrier}if(definition.terrain)delete battle.terrain}
  else if(definition.type==="sacrifice"){const unit=manual?findAllyUnitTarget(state,side,target):actor.shikigami[0];if(unit){actor.shikigami=actor.shikigami.filter(item=>item.instanceId!==unit.instanceId);actor.hp=Math.min(MAX_PLAYER_HP,actor.hp+definition.heal);actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+definition.mp)}}
  else if(definition.type==="choose_terrain"){const terrainId=choice??terrains[0]?.id;if(terrainId)battle.terrain=createFieldState(terrainById.get(terrainId)!)}
  else if(definition.type==="buff_unit"){const unit=side==="player"?findAllyUnitTarget(state,side,target):actor.shikigami[0];if(unit){unit.maxHp+=definition.maxHp;unit.hp+=definition.hp;unit.attack+=definition.attack}}
}

function executeCard(session:StoredSession,side:Side,index:number,externalTarget?:CardTarget,choice?:string):{ok:boolean;message?:string;paused?:boolean}{
  const state=session.state,battle=state.battle!,hand=handForSide(session,side),card=hand[index],definition=card?effectByCardId.get(card.cardId):undefined;
  if(!card)return {ok:false,message:"手札に存在しないカードです。"};if(!definition||definition.type==="defense")return {ok:false,message:"このカードの効果処理はまだ接続されていません。"};
  if(definition.type==="attack"){if(!validateAttackTarget(state,side,definition,externalTarget))return {ok:false,message:"Invalid target."}}else if(!validateUtilityTarget(state,side,definition,externalTarget,choice))return {ok:false,message:"Invalid target or choice."};
  const reason=isDefinitionUsable(state,side,card,definition);if(reason)return {ok:false,message:reason};const actor=stateForSide(state,side),actorAttribute=attributeForSide(state,side),cardElement=cardAttributeToElement[card.attribute];if(!cardElement&&definition.type==="attack")return {ok:false,message:"カード属性が不正です。"};actor.cost-=card.cost;actor.mp-=card.mpCost;
  if(definition.type==="attack"){
    const match=cardElement===actorAttribute,selectedTargets=attackTargets(state,side,definition,externalTarget),targets=selectedTargets.length===1?[redirectCover(state,side,selectedTargets[0])]:selectedTargets,ignore=match?applySelfMatchEffect(state,side,definition.attributeMatchEffect):0;consumeUsedCard(session,side,index);const resolve=(defense?:DefenseDefinition,defenseTarget?:DefenseTarget)=>{resolveCardAttack(state,side,card,definition,targets,cardElement!,match,ignore,defense,defenseTarget);if(cardElement&&generates[actorAttribute]===cardElement){actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+ATTRIBUTE_GENERATION_MP);battle.log.push(`相生成立：MPが${ATTRIBUTE_GENERATION_MP}増加した。`)}triggerBurnAfterCard(state,side);finishIfNeeded(state);refreshPlayability(state)};
    if(state.mode==="online"&&defenseCards(session,otherSide(side)).length){const predictions=targets.map(target=>{const targetElement=targetAttribute(state,side,target);return definition.baseDamage+(match?ATTRIBUTE_MATCH_BONUS:0)+(targetElement&&overcomes[cardElement!]===targetElement?ATTRIBUTE_OVERCOME_BONUS:0)});beginReaction(session,otherSide(side),card.name,side==="player"?(session.hostName??"Host"):(session.guestName??"Guest"),targets,predictions,(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))battle.phase="card_use"});return {ok:true,paused:true}}
    if(side==="cpu"&&defenseCards(session,"player").length){const predictions=targets.map(target=>{const targetElement=targetAttribute(state,side,target);return definition.baseDamage+(match?ATTRIBUTE_MATCH_BONUS:0)+(targetElement&&overcomes[cardElement!]===targetElement?ATTRIBUTE_OVERCOME_BONUS:0)});beginReaction(session,"player",card.name,"CPU",targets,predictions,(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))continueCpuTurn(session)});return {ok:true,paused:true}}
    if(side==="player"){const choices=defenseCards(session,"cpu"),choice=choices.find(item=>item.definition.scope==="all"||targets.length===1);if(choice&&targets.some(target=>target.type==="player"?stateForSide(state,"cpu").hp<=definition.baseDamage+2:target.unit.hp<=definition.baseDamage+2)){const cpuIndex=session.cpuHand.findIndex(item=>item.instanceId===choice.card.instanceId);stateForSide(state,"cpu").mp-=choice.card.mpCost;consumeUsedCard(session,"cpu",cpuIndex);battle.log.push(`CPUが防御札 ${choice.card.name}を使用した。`);resolve(choice.definition,choice.definition.scope==="single"?defenseTargetId(targets[0]):undefined)}else resolve()}else resolve();return {ok:true};
  }
  battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用した。`);
  resolveUtilityCard(session,side,definition,externalTarget,choice);
  if(definition.type!=="generate"&&cardElement&&generates[actorAttribute]===cardElement){actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+ATTRIBUTE_GENERATION_MP);battle.log.push(`相生成立：MPが${ATTRIBUTE_GENERATION_MP}増加した。`)}consumeUsedCard(session,side,index);if(definition.type==="cycle"||definition.type==="cycle_choice"){drawToLimit(handForSide(session,side),definition.draw);if(side==="player"||state.mode==="online"){battle.pendingDiscard={count:definition.discard,side};battle.phase="resolving"}else{for(let i=0;i<definition.discard&&session.cpuHand.length;i++){const discarded=session.cpuHand.splice(randomInt(session.cpuHand.length),1)[0];session.cpuDiscard.push(discarded)}}}triggerBurnAfterCard(state,side);finishIfNeeded(state);refreshPlayability(state);return {ok:true};
}
function usePlayerCard(session:StoredSession,instanceId:string,target:CardTarget,choice?:string):{ok:boolean;message?:string}{const battle=session.state.battle;if(!battle||session.state.phase!=="battle"||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はカードを使用できません。"};const index=battle.player.hand.findIndex(card=>card.instanceId===instanceId);return executeCard(session,"player",index,target,choice)}
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
  const battle=state.battle!,actor=stateForSide(state,side),opponentSide=otherSide(side),opponent=stateForSide(state,opponentSide),abilityEnabled=unit.abilityDisabledUntilTurn===undefined||battle.turnNumber>unit.abilityDisabledUntilTurn,protectedTarget=Boolean(defense&&(defense.scope==="all"||defenseTargetId(target)===selectedTarget));let reduction=protectedTarget&&defense?.mode==="reduce"?defense.amount:0,prevented=0,dealt=0,piercing=0;
  for(const hit of hits){if(target.type==="unit"&&target.unit.hp<=0)break;let adjusted=hit;if(protectedTarget&&defense?.mode==="nullify")adjusted=0;else if(reduction>0){const used=Math.min(reduction,adjusted);adjusted-=used;reduction-=used}prevented+=hit-adjusted;if(target.type==="player")dealt+=applyDamageToPlayer(state,opponentSide,adjusted);else{const hpBefore=target.unit.hp,damage=applyDamageToUnit(state,target.unit,adjusted);dealt+=Math.min(hpBefore,damage);if(unit.keywords.includes("貫通")&&damage>hpBefore)piercing+=damage-hpBefore}}
  battle.log.push(`${unit.name}が${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}へ${dealt}ダメージ。`);
  if(piercing>0){const damage=applyDamageToPlayer(state,opponentSide,piercing);battle.log.push(`貫通により${opponentSide==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`)}
  const damagedTargets=dealt>0?[target]:[];if(defense)applyDefensePostEffect(state,opponentSide,defense,[target],damagedTargets,prevented,side,{type:"unit",unit});
  cleanupUnits(state,opponentSide);cleanupUnits(state,side);
  const targetAlive=target.type==="unit"&&shikigamiIsAlive(state,opponentSide,target.unit),attackerAlive=shikigamiIsAlive(state,side,unit);
  if(targetAlive&&attackerAlive&&target.unit.keywords.includes("反撃")){const damage=applyDamageToUnit(state,unit,1);battle.log.push(`${target.unit.name}の反撃により${unit.name}へ${damage}ダメージ。`);if(target.unit.shikigamiId==="shikigami_shirozaru")target.unit.nextAttackBonus=Math.max(target.unit.nextAttackBonus,1);cleanupUnits(state,side)}
  if(shikigamiIsAlive(state,side,unit)){
    if(abilityEnabled&&unit.shikigamiId==="shikigami_orochi"&&target.type==="unit"&&dealt>0&&shikigamiIsAlive(state,opponentSide,target.unit)){addCurse(target.unit.curses,"curse_poison");battle.log.push(`${target.unit.name}に呪い：毒を1スタック付与した。`)}
    if(abilityEnabled&&unit.shikigamiId==="shikigami_hinotori"&&dealt>0){if(target.type==="player")addCurse(opponent.curses,"curse_burn");else if(shikigamiIsAlive(state,opponentSide,target.unit))addCurse(target.unit.curses,"curse_burn")}
    if(abilityEnabled&&unit.shikigamiId==="shikigami_karasutengu"){const others=opponent.shikigami.filter(enemy=>target.type!=="unit"||enemy.instanceId!==target.unit.instanceId);if(others.length){const splash=others[randomInt(others.length)],damage=applyDamageToUnit(state,splash,1);battle.log.push(`天狗風により${splash.name}へ${damage}ダメージ。`)}}
  }
  cleanupUnits(state,opponentSide);
  if(shikigamiIsAlive(state,side,unit)){
    if(abilityEnabled&&unit.shikigamiId==="shikigami_kanko"){actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+1);battle.log.push("霊気集めによりMPが1増加した。")}
    if(abilityEnabled&&unit.shikigamiId==="shikigami_kappa"&&actor.shikigami.length){const heal=[...actor.shikigami].sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];heal.hp=Math.min(heal.maxHp,heal.hp+1);battle.log.push(`水薬により${heal.name}のHPが1回復。`)}
    if(abilityEnabled&&unit.shikigamiId==="shikigami_komainu")unit.nextDamageReduction=Math.max(unit.nextDamageReduction,1);
    const burn=unit.curses.find(curse=>curse.id==="curse_burn");if(burn){const damage=applyDamageToUnit(state,unit,1);battle.log.push(`火傷により${unit.name}へ${damage}ダメージ。`);burn.remainingTriggers=(burn.remainingTriggers??2)-1;if(burn.remainingTriggers<=0)unit.curses=unit.curses.filter(curse=>curse!==burn);cleanupUnits(state,side)}
  }
  finishIfNeeded(state);
}
function runOneShikigamiAction(session:StoredSession,side:Side,unit:ShikigamiState,resume?:()=>void):{paused:boolean}{
  const state=session.state,battle=state.battle!,opponent=stateForSide(state,otherSide(side));
  beginShikigamiAction(unit);
  if(unit.cannotActTurn===battle.turnNumber){battle.log.push(unit.name+" cannot act on the revival turn.");return {paused:false}}
  const frozen=unit.curses.find(curse=>curse.id==="curse_freeze");if(frozen){unit.curses=unit.curses.filter(curse=>curse!==frozen);battle.log.push(unit.name+" lost its action to Freeze.");return {paused:false}}
  const paralysis=unit.curses.find(curse=>curse.id==="curse_paralysis");if(paralysis){paralysis.remainingTriggers=(paralysis.remainingTriggers??2)-1;const failed=randomInt(100)<50;if(paralysis.remainingTriggers<=0)unit.curses=unit.curses.filter(curse=>curse!==paralysis);if(failed){battle.log.push(unit.name+" failed to act due to Paralysis.");return {paused:false}}}
  const abilityEnabled=unit.abilityDisabledUntilTurn===undefined||battle.turnNumber>unit.abilityDisabledUntilTurn;
  if(abilityEnabled&&unit.shikigamiId==="shikigami_genki"&&unit.hp<=unit.maxHp/2&&unit.shellDamageReduction<2){unit.shellDamageReduction=2;battle.log.push(`${unit.name}は甲羅籠りを行った。`);return {paused:false}}
  const target=redirectCover(state,side,chooseUnitTarget(state,side,unit)),unitElement=cardAttributeToElement[unit.attribute]!,targetElement=targetAttribute(state,side,target);let total=unit.attack+unit.nextAttackBonus+(unitElement===attributeForSide(state,side)?ATTRIBUTE_MATCH_BONUS:0)+(targetElement&&overcomes[unitElement]===targetElement?ATTRIBUTE_OVERCOME_BONUS:0);unit.nextAttackBonus=0;
  if(abilityEnabled&&unit.shikigamiId==="shikigami_hakuro"){const hpValues=[opponent.hp,...opponent.shikigami.map(enemy=>enemy.hp)],targetHp=target.type==="player"?opponent.hp:target.unit.hp;if(targetHp===Math.min(...hpValues))total+=1}
  const hits=unit.shikigamiId==="shikigami_kamaitachi"?[Math.ceil(total/2),Math.floor(total/2)]:[total],resolve=(defense?:DefenseDefinition,defenseTarget?:DefenseTarget)=>resolveShikigamiAttack(state,side,unit,target,hits,defense,defenseTarget);
  if(state.mode==="online"&&defenseCards(session,otherSide(side)).length){beginReaction(session,otherSide(side),"Normal attack",unit.name,[target],[hits.reduce((sum,hit)=>sum+hit,0)],(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))resume?.()});return {paused:true}}
  if(side==="cpu"&&defenseCards(session,"player").length){beginReaction(session,"player","通常攻撃",unit.name,[target],[hits.reduce((sum,hit)=>sum+hit,0)],(defense,defenseTarget)=>{resolve(defense,defenseTarget);if(!finishIfNeeded(state))continueCpuTurn(session)});return {paused:true}}
  if(side==="player"){const choices=defenseCards(session,"cpu"),choice=choices[0];if(choice&&((target.type==="player"?opponent.hp:target.unit.hp)<=total)){const index=session.cpuHand.findIndex(card=>card.instanceId===choice.card.instanceId);opponent.mp-=choice.card.mpCost;consumeUsedCard(session,"cpu",index);battle.log.push(`CPUが防御札 ${choice.card.name}を使用した。`);resolve(choice.definition,choice.definition.scope==="single"?defenseTargetId(target):undefined)}else resolve()}else resolve();return {paused:false};
}
function runPlayerShikigamiPhase(session:StoredSession):void{const state=session.state;for(const instanceId of stateForSide(state,"player").shikigami.map(unit=>unit.instanceId)){const unit=stateForSide(state,"player").shikigami.find(candidate=>candidate.instanceId===instanceId);if(!unit||finishIfNeeded(state))break;runOneShikigamiAction(session,"player",unit)}}
function removeOneCurse(curses:CurseState[]):boolean{if(!curses.length)return false;const curse=curses[0];if(curse.stacks>1)curse.stacks-=1;else curses.shift();return true}
function processTurnStart(state:SessionState,side:Side):void{
  const battle=state.battle!,actor=stateForSide(state,side),opponent=stateForSide(state,otherSide(side));
  if(battle.terrain?.id==="terrain_clear_stream"){battle.player.mp=Math.min(MAX_PLAYER_MP,battle.player.mp+1);battle.cpu.mp=Math.min(MAX_PLAYER_MP,battle.cpu.mp+1);battle.log.push("清流により両プレイヤーのMPが1増加した。")}else if(battle.terrain?.id==="terrain_mineral_vein"){actor.cost+=1;battle.log.push(`鉱脈により${side==="player"?"プレイヤー":"CPU"}のコストが1増加した。`)}
  if(actor.barrier?.id==="barrier_spirit_vein"){if(actor.barrier.skipNextTrigger)actor.barrier.skipNextTrigger=false;else{actor.mp=Math.min(MAX_PLAYER_MP,actor.mp+1);battle.log.push(`霊脈結界により${side==="player"?"プレイヤー":"CPU"}のMPが1増加した。`)}}
  if(opponent.barrier?.id==="barrier_binding"){if(opponent.barrier.skipNextTrigger)opponent.barrier.skipNextTrigger=false;else{const candidates=actor.shikigami;if(candidates.length){const target=candidates[randomInt(candidates.length)],existing=target.curses.find(curse=>curse.id==="curse_binding");if(existing)existing.remainingTriggers=1;else target.curses.push({id:"curse_binding",name:"呪縛",stacks:1,remainingTriggers:1});battle.log.push(`呪縛結界により${target.name}へ呪い：呪縛を付与した。`)}opponent.barrier.triggerCount=(opponent.barrier.triggerCount??1)-1;if(opponent.barrier.triggerCount<=0){battle.log.push("呪縛結界が消滅した。");delete opponent.barrier}}}
}
function processTurnEnd(state:SessionState,side:Side):void{
  const battle=state.battle!,actor=stateForSide(state,side);
  if(actor.barrier?.id==="barrier_purification"){if(actor.barrier.skipNextTrigger)actor.barrier.skipNextTrigger=false;else{let removed=removeOneCurse(actor.curses);if(!removed){const candidates=actor.shikigami.filter(unit=>unit.curses.length).sort((a,b)=>b.curses.length-a.curses.length);if(candidates[0])removed=removeOneCurse(candidates[0].curses)}if(removed)battle.log.push("浄化結界が自分側の呪いを1つ解除した。")}}
  if(battle.terrain?.id==="terrain_chinju_forest"){for(const owner of [battle.player,battle.cpu])for(const unit of owner.shikigami)unit.hp=Math.min(unit.maxHp,unit.hp+1);battle.log.push("鎮守の森がすべての式神を1回復した。")}
  else if(battle.terrain?.id==="terrain_scorched_earth"){for(const owner of [battle.player,battle.cpu])for(const unit of owner.shikigami)applyDamageToUnit(state,unit,1);battle.log.push("焦土がすべての式神へ1ダメージを与えた。");cleanupUnits(state,"player");cleanupUnits(state,"cpu")}
  for(const unit of actor.shikigami)unit.curses=unit.curses.filter(curse=>curse.id!=="curse_binding");actor.curses=actor.curses.filter(curse=>curse.id!=="curse_silence");finishIfNeeded(state);
}function resolvePoisonAtTurnEnd(state:SessionState,side:Side):void{
  const battle=state.battle!,owner=stateForSide(state,side),poison=owner.curses.find(curse=>curse.id==="curse_poison");if(poison){const damage=applyDamageToPlayer(state,side,poison.stacks,0,true);battle.log.push(`毒により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`)}
  for(const unit of owner.shikigami){const curse=unit.curses.find(item=>item.id==="curse_poison");if(curse){const damage=applyDamageToUnit(state,unit,curse.stacks);battle.log.push(`毒により${unit.name}へ${damage}ダメージ。`)}}cleanupUnits(state,side);finishIfNeeded(state);
}

const aiScoreById=new Map(aiScores.map(item=>[item.id,typeof item.score==="number"?item.score:0]));
function aiValue(id:string):number{return aiScoreById.get(id)??0}
function cpuCardScore(session:StoredSession,card:CardView,definition:CardEffectDefinition):number{
  const state=session.state,battle=state.battle!,actor=battle.cpu,opponent=battle.player;let score=-card.mpCost*aiValue("ai_resource_penalty")*-1;
  if(definition.type==="attack"){const damage=definition.baseDamage+(cardAttributeToElement[card.attribute]===state.cpuAttribute?ATTRIBUTE_MATCH_BONUS:0);if(definition.target==="opponent_any"){score+=damage*aiValue("ai_damage_player");if(damage>=opponent.hp)score+=aiValue("ai_lethal")}else{const targets=definition.target==="opponent_units"?opponent.shikigami:opponent.shikigami.slice(0,1);score+=targets.reduce((sum,unit)=>sum+Math.min(unit.hp,damage)*aiValue("ai_damage_shikigami")+(damage>=unit.hp?aiValue("ai_kill_shikigami"):0),0)}}
  else if(definition.type==="summon"||definition.type==="revive")score+=aiValue("ai_summon");
  else if(definition.type==="barrier")score+=aiValue("ai_barrier")-(actor.barrier?10:0);
  else if(definition.type==="terrain"||definition.type==="choose_terrain")score+=aiValue("ai_terrain");
  else if(definition.type==="cleanse"||definition.type==="cleanse_all_units")score+=aiValue("ai_cleanse");
  else if(definition.type==="restore")score+=Math.min(MAX_PLAYER_HP-actor.hp,definition.hp)*aiValue("ai_heal_player")+Math.min(MAX_PLAYER_MP-actor.mp,definition.mp)*aiValue("ai_gain_mp");
  else if(definition.type==="generate")score+=definition.successMp*aiValue("ai_gain_mp");
  else if(definition.type==="cycle"||definition.type==="cycle_choice")score+=definition.draw*aiValue("ai_draw");
  else if(definition.type==="buff_unit")score+=aiValue("ai_summon");
  else score+=10;
  return score+randomInt(4);
}
function cpuChoice(definition:CardEffectDefinition):string|undefined{
  if((definition.type==="turn_choice"||definition.type==="cycle_choice")&&Array.isArray(definition.steps))return String(definition.steps[randomInt(definition.steps.length)]);
  if(definition.type==="choose_terrain")return terrains[randomInt(terrains.length)]?.id;
  return undefined;
}
function clearTurnTimer(session:StoredSession):void{if(session.turnTimer)clearTimeout(session.turnTimer);session.turnTimer=undefined}
function clearCpuStartTimer(session:StoredSession):void{if(session.cpuStartTimer)clearTimeout(session.cpuStartTimer);session.cpuStartTimer=undefined}
function armPlayerTurnTimer(session:StoredSession,duration=60_000):void{
  clearTurnTimer(session);const battle=session.state.battle;if(!battle||battle.phase==="finished"||battle.activePlayer!=="player")return;
  battle.turnDeadline=Date.now()+duration;session.turnTimer=setTimeout(()=>{const current=session.state.battle;if(!current||current.phase==="finished"||current.activePlayer!=="player")return;current.log.push("Turn time expired.");endPlayerTurn(session);sendSessionState(session)},duration);
}

function continueCpuTurn(session:StoredSession):void{
  const state=session.state,battle=state.battle!;
  if(!session.cpuShikigamiQueue){while(session.cpuCardActions<5&&!finishIfNeeded(state)){const candidates=session.cpuHand.map((card,index)=>({card,index,definition:effectByCardId.get(card.cardId)})).filter(item=>item.definition&&item.definition.type!=="defense"&&!isDefinitionUsable(state,"cpu",item.card,item.definition));if(!candidates.length)break;const scored=candidates.map(item=>({item,value:cpuCardScore(session,item.card,item.definition!)}));const best=Math.max(...scored.map(candidate=>candidate.value)),choices=scored.filter(candidate=>candidate.value===best),chosen=choices[randomInt(choices.length)].item;session.cpuCardActions+=1;const result=executeCard(session,"cpu",chosen.index,undefined,cpuChoice(chosen.definition!));if(result.paused){battle.cpu.handCount=session.cpuHand.length;refreshPlayability(state);return}}battle.cpu.handCount=session.cpuHand.length;session.cpuShikigamiQueue=stateForSide(state,"cpu").shikigami.map(unit=>unit.instanceId);battle.phase="resolving";battle.log.push("CPUの式神行動フェーズ。")}
  while(session.cpuShikigamiQueue.length&&!finishIfNeeded(state)){const instanceId=session.cpuShikigamiQueue.shift()!,unit=stateForSide(state,"cpu").shikigami.find(candidate=>candidate.instanceId===instanceId);if(!unit)continue;const result=runOneShikigamiAction(session,"cpu",unit);if(result.paused){refreshPlayability(state);return}}
  delete session.cpuShikigamiQueue;processTurnEnd(state,"cpu");resolvePoisonAtTurnEnd(state,"cpu");if(finishIfNeeded(state)){refreshPlayability(state);return}
  battle.turnNumber+=1;battle.activePlayer="player";battle.phase="card_use";refreshTurnHand(session,"player");battle.player.cost=5;processTurnStart(state,"player");battle.log.push(`第${battle.turnNumber}ターン開始。手札とコストを更新した。`);refreshPlayability(state);armPlayerTurnTimer(session);
}
function scheduleCpuTurn(session:StoredSession):void{
  clearCpuStartTimer(session);session.cpuStartTimer=setTimeout(()=>{session.cpuStartTimer=undefined;const battle=session.state.battle;if(!battle||battle.phase==="finished"||battle.activePlayer!=="cpu")return;continueCpuTurn(session);sendSessionState(session)},CPU_TURN_START_DELAY_MS);
}
function endPlayerTurn(session:StoredSession):{ok:boolean;message?:string}{
  const state=session.state,battle=state.battle;if(session.turnTimer)clearTurnTimer(session);if(!battle||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はターンを終了できません。"};battle.phase="resolving";battle.log.push("プレイヤーの式神行動フェーズ。");runPlayerShikigamiPhase(session);processTurnEnd(state,"player");resolvePoisonAtTurnEnd(state,"player");if(finishIfNeeded(state)){refreshPlayability(state);return {ok:true}}
  battle.activePlayer="cpu";refreshTurnHand(session,"cpu");stateForSide(state,"cpu").cost=5;processTurnStart(state,"cpu");battle.log.push("CPUターン開始。");session.cpuCardActions=0;delete session.cpuShikigamiQueue;scheduleCpuTurn(session);return {ok:true};
}


function initializeBattle(session:StoredSession):void{
  const hand=drawCards(5);session.cpuHand=drawCards(5);session.state.phase="battle";session.state.battle={turnNumber:1,activePlayer:"player",phase:"card_use",player:{hp:INITIAL_PLAYER_HP,mp:INITIAL_PLAYER_MP,cost:5,curses:[],nextDamageReduction:0,shikigami:[],retiredShikigami:[],hand,discard:[]},cpu:{hp:INITIAL_PLAYER_HP,mp:INITIAL_PLAYER_MP,cost:5,curses:[],nextDamageReduction:0,shikigami:[],retiredShikigami:[],handCount:session.cpuHand.length},log:[`対戦開始。両者HP${INITIAL_PLAYER_HP}・MP${INITIAL_PLAYER_MP}で手札を5枚引いた。`]};refreshPlayability(session.state);if(session.mode!=="online")armPlayerTurnTimer(session);
}
function useCardForSide(session:StoredSession,side:Side,instanceId:string,target:CardTarget,choice?:string):{ok:boolean;message?:string}{
  const battle=session.state.battle;if(!battle||session.state.phase!=="battle"||battle.phase!=="card_use"||battle.activePlayer!==side)return {ok:false,message:"It is not your card-use phase."};
  const index=handForSide(session,side).findIndex(card=>card.instanceId===instanceId);return executeCard(session,side,index,target,choice);
}
function armOnlineTurnTimer(session:StoredSession,duration=60_000):void{
  clearTurnTimer(session);const battle=session.state.battle;if(session.mode!=="online"||!battle||battle.phase!=="card_use"||session.state.connectionPaused)return;
  battle.turnDeadline=Date.now()+duration;session.turnTimer=setTimeout(()=>{const current=session.state.battle;if(!current||current.phase!=="card_use"||session.state.connectionPaused)return;current.log.push("Turn time expired.");endOnlineTurn(session,current.activePlayer);sendSessionState(session)},duration);
}
function returnOnlineRoomToLobby(session:StoredSession):void{
  clearTurnTimer(session);if(session.state.phase==="battle"&&session.hostToken&&session.guestToken)renewOnlineTokens(session);if(session.rematchTimer)clearTimeout(session.rematchTimer);session.rematchTimer=undefined;session.rematchVotes=new Set();session.state={phase:"room_waiting",mode:"online",roomId:session.roomId,roomReady:Boolean(session.guestToken)};sendSessionState(session);
}
function armRematchWindow(session:StoredSession):void{
  if(session.mode!=="online"||session.rematchTimer)return;session.rematchVotes=new Set();session.state.rematchStatus="waiting";session.state.rematchDeadline=Date.now()+30_000;session.rematchTimer=setTimeout(()=>returnOnlineRoomToLobby(session),30_000);sendSessionState(session);
}
function armAttributeSelectionTimer(session:StoredSession):void{
  if(session.attributeTimer)clearTimeout(session.attributeTimer);session.attributeTimer=setTimeout(()=>{if(session.state.phase!=="attribute_selection")return;if(session.mode==="online")returnOnlineRoomToLobby(session);else{for(const [token,value] of sessions)if(value===session)sessions.delete(token);session.state={phase:"title"};sendSessionState(session)}},30_000);
}
function renewOnlineTokens(session:StoredSession):void{
  const oldHost=session.hostToken!,oldGuest=session.guestToken!,newHost=randomUUID(),newGuest=randomUUID();
  for(const [socketId,token] of socketTokens){if(token===oldHost)socketTokens.set(socketId,newHost);else if(token===oldGuest)socketTokens.set(socketId,newGuest)}
  sessions.delete(oldHost);sessions.delete(oldGuest);tokenSides.delete(oldHost);tokenSides.delete(oldGuest);session.hostToken=newHost;session.guestToken=newGuest;sessions.set(newHost,session);sessions.set(newGuest,session);tokenSides.set(newHost,"player");tokenSides.set(newGuest,"cpu");const room=session.roomId?rooms.get(session.roomId):undefined;if(room){room.hostToken=newHost;room.guestToken=newGuest}
}
function startOnlineRematch(session:StoredSession):void{
  if(session.rematchTimer)clearTimeout(session.rematchTimer);session.rematchTimer=undefined;renewOnlineTokens(session);session.rematchVotes=new Set();session.state={phase:"attribute_selection",mode:"online",roomId:session.roomId,roomReady:true};armAttributeSelectionTimer(session);sendSessionState(session);
}
function completeOnlineTurn(session:StoredSession,side:Side):void{
  const state=session.state,battle=state.battle!;processTurnEnd(state,side);resolvePoisonAtTurnEnd(state,side);if(finishIfNeeded(state)){armRematchWindow(session);return}
  const next=otherSide(side);if(side==="cpu")battle.turnNumber+=1;battle.activePlayer=next;battle.phase="card_use";refreshTurnHand(session,next);const actor=stateForSide(state,next);actor.cost=5;processTurnStart(state,next);battle.cpu.handCount=session.cpuHand.length;refreshPlayability(state);armOnlineTurnTimer(session);
}
function continueOnlineTurn(session:StoredSession):void{
  const side=session.onlineTurnSide,queue=session.onlineShikigamiQueue;if(!side||!queue)return;const state=session.state;
  while(queue.length&&!finishIfNeeded(state)){const id=queue.shift()!,unit=stateForSide(state,side).shikigami.find(item=>item.instanceId===id);if(!unit)continue;const result=runOneShikigamiAction(session,side,unit,()=>{continueOnlineTurn(session);sendSessionState(session)});if(result.paused){refreshPlayability(state);return}}
  delete session.onlineTurnSide;delete session.onlineShikigamiQueue;completeOnlineTurn(session,side);sendSessionState(session);
}
function endOnlineTurn(session:StoredSession,side:Side):{ok:boolean;message?:string}{
  const state=session.state,battle=state.battle;if(!battle||battle.phase!=="card_use"||battle.activePlayer!==side)return {ok:false,message:"It is not your turn."};
  clearTurnTimer(session);battle.phase="resolving";session.onlineTurnSide=side;session.onlineShikigamiQueue=stateForSide(state,side).shikigami.map(unit=>unit.instanceId);continueOnlineTurn(session);return {ok:true};
}
function roomCode():string{let code="";do{code=randomInt(0,36**6).toString(36).padStart(6,"0").toUpperCase()}while(rooms.has(code));return code}
function leaveOnlineRoom(session:StoredSession,leavingToken:string):void{
  clearTurnTimer(session);if(session.attributeTimer)clearTimeout(session.attributeTimer);if(session.rematchTimer)clearTimeout(session.rematchTimer);if(session.pendingReaction?.timer)clearTimeout(session.pendingReaction.timer);for(const timer of session.onlineReconnectTimers?.values()??[])clearTimeout(timer);
  const leavingSide=tokenSides.get(leavingToken)??"player",room=session.roomId?rooms.get(session.roomId):undefined,battle=session.state.battle;
  if(battle&&battle.phase!=="finished"){battle.phase="finished";battle.winner=otherSide(leavingSide);battle.log.push("A player left the match.");sendSessionState(session)}
  else{session.state={phase:"title"};sendSessionState(session)}
  if(room)rooms.delete(room.id);for(const token of [session.hostToken,session.guestToken])if(token){sessions.delete(token);tokenSides.delete(token)}
}

app.get("/health",(_request,response)=>response.json({status:"ok"}));app.get("/api/cards",(_request,response)=>response.json({cards:publicCardCatalog}));app.use(express.static(distributionDirectory));app.get("/",(_request,response)=>response.type("html").send(rootDocument));
io.on("connection",socket=>{
  sendState(socket.id,{phase:"title"});
  const acknowledge=(session:StoredSession,callback:(result:{ok:boolean;message?:string;state?:SessionState})=>void)=>callback({ok:true,state:publicStateForSocket(socket.id,session)});
  const unavailable=(session:StoredSession|undefined):boolean=>Boolean(session?.state.connectionPaused);
  socket.on("session:resume",(token,callback)=>{const session=sessions.get(token);if(!session){callback({ok:false,message:"No resumable match was found."});return}socketTokens.set(socket.id,token);if(session.mode==="online"){session.disconnectedTokens?.delete(token);const timer=session.onlineReconnectTimers?.get(token);if(timer)clearTimeout(timer);session.onlineReconnectTimers?.delete(token);if(!session.disconnectedTokens?.size){session.state.connectionPaused=false;if(session.pendingReaction&&!session.pendingReaction.timer)armReactionTimer(session,session.pendingReaction);else if(session.state.battle?.phase==="card_use")armOnlineTurnTimer(session,session.turnRemainingMs??60_000);session.turnRemainingMs=undefined}}else{if(session.reconnectTimer)clearTimeout(session.reconnectTimer);session.reconnectTimer=undefined;session.disconnectedAt=undefined;if(session.pendingReaction&&!session.pendingReaction.timer)armReactionTimer(session,session.pendingReaction);if(session.turnRemainingMs!==undefined){armPlayerTurnTimer(session,session.turnRemainingMs);session.turnRemainingMs=undefined}}refreshPlayability(session.state);acknowledge(session,callback);sendSessionState(session)});
  socket.on("cpu:start",({playerName},callback)=>{const name=playerName.trim();if(!name){callback({ok:false,message:"Enter a player name."});return}const previous=socketTokens.get(socket.id);if(previous)sessions.delete(previous);const token=randomUUID(),state:SessionState={phase:"attribute_selection",mode:"cpu",reconnectToken:token,playerName:name};const created:StoredSession={state,mode:"cpu",cpuHand:[],cpuDiscard:[],cpuCardActions:0};sessions.set(token,created);socketTokens.set(socket.id,token);armAttributeSelectionTimer(created);acknowledge(created,callback);sendSessionState(created)});
  socket.on("room:create",({playerName},callback)=>{const name=playerName.trim();if(!name){callback({ok:false,message:"Enter a player name."});return}const token=randomUUID(),id=roomCode(),state:SessionState={phase:"room_waiting",mode:"online",roomId:id,roomReady:false};const session:StoredSession={state,mode:"online",roomId:id,hostToken:token,hostName:name,cpuHand:[],cpuDiscard:[],cpuCardActions:0,disconnectedTokens:new Set(),onlineReconnectTimers:new Map()};sessions.set(token,session);tokenSides.set(token,"player");socketTokens.set(socket.id,token);rooms.set(id,{id,session,hostToken:token});acknowledge(session,callback);sendSessionState(session)});
  socket.on("room:join",({playerName,roomId},callback)=>{const name=playerName.trim(),id=roomId.trim().toUpperCase(),room=rooms.get(id);if(!name){callback({ok:false,message:"Enter a player name."});return}if(!room||room.guestToken||room.session.state.phase!=="room_waiting"){callback({ok:false,message:"The room is unavailable."});return}const token=randomUUID();room.guestToken=token;room.session.guestToken=token;room.session.guestName=name;room.session.state.roomReady=true;sessions.set(token,room.session);tokenSides.set(token,"cpu");socketTokens.set(socket.id,token);acknowledge(room.session,callback);sendSessionState(room.session)});
  socket.on("room:start",callback=>{const session=currentSession(socket.id),token=socketTokens.get(socket.id);if(!session||session.mode!=="online"||token!==session.hostToken||!session.guestToken||session.state.phase!=="room_waiting"){callback({ok:false,message:"The room cannot start yet."});return}session.state={phase:"attribute_selection",mode:"online",roomId:session.roomId,roomReady:true};armAttributeSelectionTimer(session);acknowledge(session,callback);sendSessionState(session)});
  socket.on("room:leave",callback=>{const session=currentSession(socket.id),token=socketTokens.get(socket.id);if(!session||!token){callback({ok:true,state:{phase:"title"}});return}leaveOnlineRoom(session,token);callback({ok:true,state:{phase:"title"}})});
  socket.on("attribute:select",({attribute},callback)=>{const session=currentSession(socket.id);if(!session||session.state.phase!=="attribute_selection"||unavailable(session)){callback({ok:false,message:"Attributes cannot be selected now."});return}if(!FIVE_ELEMENTS.includes(attribute)){callback({ok:false,message:"Invalid attribute."});return}if(session.mode==="online"){setAttributeForSide(session.state,sideForSocket(socket.id),attribute);if(session.state.playerAttribute&&session.state.cpuAttribute){if(session.attributeTimer)clearTimeout(session.attributeTimer);session.attributeTimer=undefined;session.state.phase="attribute_reveal"}}else{if(session.attributeTimer)clearTimeout(session.attributeTimer);session.attributeTimer=undefined;session.state.playerAttribute=attribute;session.state.cpuAttribute=FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];session.state.phase="attribute_reveal"}acknowledge(session,callback);sendSessionState(session)});
  socket.on("match:enter",callback=>{const session=currentSession(socket.id);if(!session||unavailable(session)||(session.state.phase!=="attribute_reveal"&&session.state.phase!=="battle")){callback({ok:false,message:"The match cannot be entered."});return}if(session.state.phase==="attribute_reveal"){initializeBattle(session);if(session.mode==="online")armOnlineTurnTimer(session)}acknowledge(session,callback);sendSessionState(session)});
  socket.on("card:use",({instanceId,target,choice},callback)=>{const session=currentSession(socket.id);if(!session||unavailable(session)){callback({ok:false,message:"Match data is unavailable or paused."});return}const result=session.mode==="online"?useCardForSide(session,sideForSocket(socket.id),instanceId,target,choice):usePlayerCard(session,instanceId,target,choice);if(!result.ok){callback(result);return}if(session.state.battle?.phase==="finished")armRematchWindow(session);acknowledge(session,callback);sendSessionState(session)});
  socket.on("card:discard",({instanceId},callback)=>{const session=currentSession(socket.id),battle=session?.state.battle,side=session?.mode==="online"?sideForSocket(socket.id):"player";if(!session||!battle?.pendingDiscard||battle.pendingDiscard.side!==side||unavailable(session)){callback({ok:false,message:"No discard is pending."});return}const hand=handForSide(session,side),index=hand.findIndex(card=>card.instanceId===instanceId);if(index<0){callback({ok:false,message:"The card is not in hand."});return}consumeUsedCard(session,side,index);battle.pendingDiscard.count-=1;if(battle.pendingDiscard.count<=0){delete battle.pendingDiscard;battle.phase="card_use"}refreshPlayability(session.state);acknowledge(session,callback);sendSessionState(session)});
  socket.on("reaction:respond",({instanceId,target},callback)=>{const session=currentSession(socket.id);if(!session||unavailable(session)){callback({ok:false,message:"Match data is unavailable or paused."});return}const result=finishReaction(session,sideForSocket(socket.id),instanceId,target);if(!result.ok){callback(result);return}if(session.state.battle?.phase==="finished")armRematchWindow(session);acknowledge(session,callback);sendSessionState(session)});
  socket.on("turn:end",callback=>{const session=currentSession(socket.id);if(!session||unavailable(session)){callback({ok:false,message:"Match data is unavailable or paused."});return}const result=session.mode==="online"?endOnlineTurn(session,sideForSocket(socket.id)):endPlayerTurn(session);if(!result.ok){callback(result);return}if(session.state.battle?.phase==="finished")armRematchWindow(session);acknowledge(session,callback);sendSessionState(session)});
  socket.on("rematch:request",callback=>{const session=currentSession(socket.id);if(!session||session.state.battle?.phase!=="finished"){callback({ok:false,message:"A rematch cannot be requested now."});return}if(session.mode!=="online"){const oldToken=socketTokens.get(socket.id),newToken=randomUUID();if(oldToken)sessions.delete(oldToken);session.state={phase:"attribute_selection",mode:"cpu",reconnectToken:newToken,playerName:session.state.playerName};session.cpuHand=[];session.cpuDiscard=[];session.cpuCardActions=0;sessions.set(newToken,session);socketTokens.set(socket.id,newToken);armAttributeSelectionTimer(session);acknowledge(session,callback);sendSessionState(session);return}const side=sideForSocket(socket.id);session.rematchVotes??=new Set();session.rematchVotes.add(side);session.state.rematchStatus="requested";if(session.rematchVotes.size===2)startOnlineRematch(session);else sendSessionState(session);acknowledge(session,callback)});
  socket.on("rematch:cancel",callback=>{const session=currentSession(socket.id);if(!session||session.mode!=="online"){callback({ok:false,message:"No online room is active."});return}returnOnlineRoomToLobby(session);acknowledge(session,callback)});
  socket.on("session:reset",callback=>{const session=currentSession(socket.id),token=socketTokens.get(socket.id);if(session?.mode==="online"&&token)leaveOnlineRoom(session,token);else{if(session){clearTurnTimer(session);clearCpuStartTimer(session);if(session.attributeTimer)clearTimeout(session.attributeTimer);if(session.reconnectTimer)clearTimeout(session.reconnectTimer);if(session.rematchTimer)clearTimeout(session.rematchTimer);if(session.pendingReaction?.timer)clearTimeout(session.pendingReaction.timer)}if(token)sessions.delete(token)}socketTokens.delete(socket.id);const resetState:SessionState={phase:"title"};callback({ok:true,state:resetState});sendState(socket.id,resetState)});
  socket.on("disconnect",()=>{const token=socketTokens.get(socket.id),session=token?sessions.get(token):undefined,pending=session?.pendingReaction,battle=session?.state.battle;if(!session||!token){socketTokens.delete(socket.id);return}if(pending?.timer&&battle?.reaction){pending.remainingMs=Math.max(0,battle.reaction.deadline-Date.now());clearTimeout(pending.timer);pending.timer=undefined}if(session.turnTimer&&battle?.turnDeadline){session.turnRemainingMs=Math.max(0,battle.turnDeadline-Date.now());clearTurnTimer(session)}if(session.mode==="online"){session.disconnectedTokens??=new Set();session.onlineReconnectTimers??=new Map();session.disconnectedTokens.add(token);session.state.connectionPaused=true;const timeout=setTimeout(()=>{session.onlineReconnectTimers?.delete(token);session.disconnectedTokens?.delete(token);if(session.state.battle&&session.state.battle.phase!=="finished"){session.state.battle.phase="finished";session.state.battle.winner=otherSide(tokenSides.get(token)??"player");session.state.connectionPaused=false;session.state.battle.log.push("Reconnect timeout. The connected player wins.");armRematchWindow(session);sendSessionState(session)}else leaveOnlineRoom(session,token)},90_000);session.onlineReconnectTimers.set(token,timeout);sendSessionState(session)}else{session.disconnectedAt=Date.now();session.reconnectTimer=setTimeout(()=>sessions.delete(token),90_000)}socketTokens.delete(socket.id)});
});
server.listen(port,()=>console.log(`五行転輪 server listening on port ${port}`));
