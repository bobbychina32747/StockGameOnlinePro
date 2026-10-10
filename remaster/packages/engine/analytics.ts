export function performance(history: {day:number;equity:number}[], initial: number): {maxDrawdown:number;sharpe:number;volatility:number;profitableDays:number;days:number;totalReturn:number} {
  const values=[initial,...history.map(item=>item.equity)];let peak=initial;let drawdown=0;
  const returns=values.slice(1).map((value,index)=>value/Math.max(1,values[index])-1);
  for(const value of values) {peak=Math.max(peak,value);drawdown=Math.max(drawdown,peak>0?1-value/peak:0);}
  const mean=returns.length?returns.reduce((sum,value)=>sum+value,0)/returns.length:0;
  const deviation=returns.length>1?Math.sqrt(returns.reduce((sum,value)=>sum+(value-mean)**2,0)/(returns.length-1)):0;
  return {maxDrawdown:drawdown,sharpe:deviation>0?mean/deviation*Math.sqrt(252):0,volatility:deviation*Math.sqrt(252),profitableDays:returns.filter(value=>value>0).length,days:returns.length,totalReturn:values.at(-1)!/Math.max(1,initial)-1};
}
