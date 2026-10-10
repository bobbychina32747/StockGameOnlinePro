import { useSyncExternalStore } from 'react';
import { MarketId, OrderType, Side } from '../../../packages/domain/types';
export interface Draft{type:OrderType;side:Side;quantity:string;price:string;trigger:string;display:string}
export type Page='trade'|'portfolio'|'competition'|'research'|'profile';
interface Workspace{market:MarketId;symbol:string;page:Page;ticketOpen:boolean;search:string;industry:string;watchOnly:boolean;watch:string[];theme:'dark'|'light';language:'zh-CN'|'en'|'zh-Hant';upIsRed:boolean;reducedMotion:boolean;drafts:Record<string,Draft>}
function stored<T>(key:string,fallback:T):T{try{return JSON.parse(localStorage.getItem(key)??'null')??fallback;}catch{return fallback;}}
let workspace:Workspace={market:'CN',symbol:'T1',page:'trade',ticketOpen:false,search:'',industry:'',watchOnly:false,watch:[],theme:stored('rgp.theme','dark'),language:stored('rgp.language','zh-CN'),upIsRed:stored('rgp.up-red',true),reducedMotion:stored('rgp.motion',false),drafts:{}};
const listeners=new Set<()=>void>();let owner='';
export function useWorkspace(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>workspace);}
export function setWorkspace(patch:Partial<Workspace>){workspace={...workspace,...patch};for(const listener of listeners)listener();}
export function changeOwner(identity:string){if(owner===identity)return;owner=identity;setWorkspace({watch:stored('rgp.watch:'+owner,[]),drafts:stored('rgp.drafts:'+owner,{})});}
export function chooseMarket(market:MarketId,symbol:string){setWorkspace({market,symbol,search:'',industry:'',watchOnly:false});}
export function toggleWatch(symbol:string){const watch=workspace.watch.includes(symbol)?workspace.watch.filter(item=>item!==symbol):[...workspace.watch,symbol];setWorkspace({watch});if(owner)localStorage.setItem('rgp.watch:'+owner,JSON.stringify(watch));}
export function updateDraft(symbol:string,patch:Partial<Draft>){const key=workspace.market+':'+symbol;const draft=workspace.drafts[key]??{type:'market',side:'buy',quantity:'100',price:'',trigger:'',display:'20'};const drafts={...workspace.drafts,[key]:{...draft,...patch}};setWorkspace({drafts});if(owner)localStorage.setItem('rgp.drafts:'+owner,JSON.stringify(drafts));}
export function preference(key:'theme'|'language'|'upIsRed'|'reducedMotion',value:any){setWorkspace({[key]:value});localStorage.setItem({'theme':'rgp.theme','language':'rgp.language','upIsRed':'rgp.up-red','reducedMotion':'rgp.motion'}[key],JSON.stringify(value));}
export function cents(text:string):number{if(!/^\d+(\.\d{1,2})?$/.test(text))throw new Error('请输入最多两位小数的金额');const [whole,fraction='']=text.split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(amount))throw new Error('金额过大');return amount;}
