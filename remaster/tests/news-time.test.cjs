const {test}=require('node:test'),assert=require('node:assert/strict');
const {publicationBounds,firstAffected}=require('../tooling/news-time.cjs');const timeline=require('../packages/domain/news-timeline.json');
test('publication aligns to first observable session across after-hours, weekends and market timezones',()=>{
 const us={market:'US',bars:['2024-05-22','2024-05-23','2024-05-24'].map(date=>({date,time:Date.parse(date+'T13:30:00Z')}))};
 const bounds=publicationBounds(timeline.events.find(event=>event.id==='nvda-20240522'));
 assert.deepEqual(bounds.map(time=>firstAffected(us,time)),[1,1]);
 const asia={market:'HK',bars:['2024-09-18','2024-09-19'].map(date=>({date,time:Date.parse(date+'T01:30:00Z')}))};
 const fed=publicationBounds(timeline.events.find(event=>event.id==='fed-20240918'));
 assert.equal(firstAffected(asia,fed[0]),1);assert.equal(fed[0],Date.parse('2024-09-18T18:00:00Z'));
 const oil={market:'US',bars:['2023-03-31','2023-04-03'].map(date=>({date,time:Date.parse(date+'T13:30:00Z')}))};
 assert.deepEqual(publicationBounds(timeline.events.find(event=>event.id==='opec-20230402')).map(time=>firstAffected(oil,time)),[1,1]);
});
test('uncertain first-publication minute is retained and event time is not silently substituted',()=>{
 const svb=timeline.events.find(event=>event.id==='svb-20230310');assert.equal(svb.firstPublicMinuteVerified,false);assert.equal(svb.publishedAt,undefined);assert(svb.eventOccurredAt);
 const summer=publicationBounds({date:'2025-07-01',market:'US',session:'after-close'}),winter=publicationBounds({date:'2025-01-02',market:'US',session:'after-close'});
 assert.equal(new Date(summer[0]).toISOString(),'2025-07-01T20:00:00.000Z');assert.equal(new Date(winter[0]).toISOString(),'2025-01-02T21:00:00.000Z');
});
