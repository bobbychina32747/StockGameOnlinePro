const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../tooling/microstructure-statistics.cjs');
test('volume features use prior rolling observations rather than future volume',()=>{
 const rows=Array.from({length:40},(_,i)=>[Date.UTC(2024,0,1+i,15),10,11,9,10,10,100]);
 const record={timezone:'America/New_York',rows,events:{}};
 const original=S.dailyFeatures(record);rows[30][6]=1000000;
 const updated=S.dailyFeatures(record);assert.deepEqual(original.filter(r=>r.date<'2024-01-31'),updated.filter(r=>r.date<'2024-01-31'));
 assert.equal(updated.find(r=>r.date==='2024-01-31').relative,10000);
});
test('intraday session mapping excludes lunch and handles close without adding an extra trading minute',()=>{
 assert.equal(S.sessionMinute('CN',720),null);assert.equal(S.sessionMinute('CN',780),120);
 assert.equal(S.sessionMinute('HK',780),150);assert.equal(S.sessionMinute('US',960),389);
 const weights=S.seasonality([{rows:Array.from({length:12},(_,bucket)=>({bucket,relative:bucket===0?4:1}))}]);
 assert(Math.abs(S.mean(weights)-1)<1e-12);assert(weights[0]>weights[5]);
});
