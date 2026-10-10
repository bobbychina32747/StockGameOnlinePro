import { hashSeed } from './random';
import intraday from '../domain/intraday-calibration.json';
import { MarketId } from '../domain/types';
export interface VolatilityState { variance:number; shock:number }
export function generator(seed:number):()=>number {
  let state=seed>>>0;
  return ()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
}
export function gaussian(draw:()=>number):number {return Math.sqrt(-2*Math.log(Math.max(1e-12,draw())))*Math.cos(2*Math.PI*draw());}
export function student(draw:()=>number):number {
  const numerator=gaussian(draw);let squares=0;for(let index=0;index<5;index++)squares+=gaussian(draw)**2;
  return Math.max(-12,Math.min(12,numerator*Math.sqrt(3/Math.max(1e-9,squares))));
}
export function conditionalVariance(previous:VolatilityState,parameters={omega:.035,alpha:.07,gamma:.10,beta:.845}):number {
  const squared=previous.shock**2;
  return Math.max(.15,Math.min(25,parameters.omega+parameters.alpha*squared+(previous.shock<0?parameters.gamma*squared:0)+parameters.beta*previous.variance));
}
export function factor(seed:number,label:string,date:string):number {return student(generator(hashSeed(`${seed}:${label}:${date}`)));}
export function updateVolatility(state:VolatilityState,innovation:number,parameters?:{omega:number;alpha:number;gamma:number;beta:number}):number {
  state.variance=conditionalVariance(state,parameters);state.shock=Math.sqrt(state.variance)*innovation;return state.shock;
}
export function intradayActivity(minute:number,length:number,market?:MarketId):number {
  const progress=Math.max(0,Math.min(1,minute/length));
  if(market){const profile=intraday.profiles[market];return profile.normalization*(1+profile.openBoost*Math.exp(-progress*14)+profile.closeBoost*Math.exp(-(1-progress)*14));}
  return .72+1.1*Math.exp(-progress*14)+.85*Math.exp(-(1-progress)*14);
}
export function minuteParameters(length:number,parameters={omega:.035,alpha:.07,gamma:.10,beta:.845}):typeof parameters {
  return {omega:parameters.omega/length,alpha:parameters.alpha/length,gamma:parameters.gamma/length,beta:1-(1-parameters.beta)/length};
}
