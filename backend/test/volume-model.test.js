const {calibratedVolume,modeledFloatShares}=require('../dist/src/common/volume-model');
const calibration=require('../dist/src/common/unified-volume.json');
const make=()=>({symbol:'TEST',industry:'半导体',baseVolume:10000,volatility:.02,lastReturn:0,minuteCounter:0});
test('volume calibration covers all 69 sector-market groups and daily-normalized seasonal profiles',()=>{
 expect(Object.keys(calibration.profiles)).toHaveLength(69);
 for(const weights of Object.values(calibration.marketSeasonality)){
  expect(weights).toHaveLength(12);expect(weights.every(v=>v>0&&Number.isFinite(v))).toBe(true);
  expect(weights.reduce((s,v)=>s+v,0)/12).toBeCloseTo(1,10);
 }
});
test('large positive and negative moves increase activity equally; quiet opening is busier than midday',()=>{
 const up={...make(),lastReturn:.01},down={...make(),lastReturn:-.01},quiet=make();
 const a=calibratedVolume(up,'CN',240,()=>0),b=calibratedVolume(down,'CN',240,()=>0);
 expect(a).toBe(b);expect(a).toBeGreaterThan(calibratedVolume(quiet,'CN',240,()=>0));
 expect(calibratedVolume(make(),'CN',240,()=>0)).toBeGreaterThan(calibratedVolume({...make(),minuteCounter:100},'CN',240,()=>0)*2);
});
test('volume shocks persist without unbounded growth and unknown turnover remains missing',()=>{
 const stock=make();calibratedVolume(stock,'CN',240,()=>1);const first=stock.volumeState.shock;
 calibratedVolume(stock,'CN',240,()=>0);expect(stock.volumeState.shock).toBeGreaterThan(0);expect(stock.volumeState.shock).toBeLessThan(first);
 for(let i=0;i<1000;i++)calibratedVolume(stock,'CN',240,()=>100);
 expect(stock.volumeState.shock).toBeLessThanOrEqual(2.5);
 expect(modeledFloatShares(stock,'CN',240)).toBeGreaterThan(0);
 expect(modeledFloatShares(stock,'HK',330)).toBeNull();
 expect(modeledFloatShares({...stock,industry:'unknown'},'CN',240)).toBeNull();
});
test('published earnings activity decays without changing price or remaining indefinitely',()=>{
 const stock={...make(),price:100,eventVolumeState:{boost:1.84,remaining:30}};
 const baseline=calibratedVolume(make(),'CN',240,()=>0),first=calibratedVolume(stock,'CN',240,()=>0);
 expect(first).toBeGreaterThan(baseline);for(let i=0;i<30;i++)calibratedVolume(stock,'CN',240,()=>0);
 expect(stock.eventVolumeState.remaining).toBe(0);expect(stock.price).toBe(100);
 expect(calibratedVolume(stock,'CN',240,()=>0)).toBe(baseline);
});
