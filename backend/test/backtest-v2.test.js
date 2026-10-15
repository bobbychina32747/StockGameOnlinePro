const {MarketController}=require('../dist/src/modules/market/market.controller');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');

test('v2 compute bridge preserves cent rounding, prior bars and the unchanged engine result',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sgp-backtest-'));
  const modulePath=path.join(directory,'fixture.cjs');
  fs.writeFileSync(modulePath,'exports.backtest=(symbol,bars,strategy,seed)=>({symbol,bars,strategy,seed,tradeDetails:[{id:"kept"}]});','utf8');
  const previous=process.env.V2_BACKTEST_MODULE;process.env.V2_BACKTEST_MODULE=modulePath;
  const bars=[{time:new Date('2026-10-15T00:00:00Z'),open:12.34,close:12.35,high:13,low:12,volume:100},
    {time:new Date('2026-10-16T00:00:00Z'),open:12.35,close:12.5,high:13,low:12,volume:200}];
  try{
    const controller=new MarketController({getKlines:async()=>bars});
    const result=await controller.backtestV2({symbol:'X1',strategy:'ma'});
    expect(result.bars).toHaveLength(1);expect(result.bars[0].open).toBe(1234);expect(result.bars[0].close).toBe(1235);
    expect(result.seed).toBe(20261010);expect(result.tradeDetails).toEqual([{id:'kept'}]);
    expect(bars[0].open).toBe(12.34);
    await expect(controller.backtestV2({symbol:'X1',strategy:'invalid'})).rejects.toMatchObject({status:400});
  }finally{if(previous===undefined)delete process.env.V2_BACKTEST_MODULE;else process.env.V2_BACKTEST_MODULE=previous;}
});

test('a missing compatibility module fails explicitly instead of using a different algorithm',async()=>{
  const previous=process.env.V2_BACKTEST_MODULE;process.env.V2_BACKTEST_MODULE=path.join(os.tmpdir(),'sgp-module-does-not-exist.cjs');
  try{await expect(new MarketController({}).backtestV2({symbol:'X1',strategy:'ma'})).rejects.toMatchObject({status:503});}
  finally{if(previous===undefined)delete process.env.V2_BACKTEST_MODULE;else process.env.V2_BACKTEST_MODULE=previous;}
});
