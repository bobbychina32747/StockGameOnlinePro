function publicationBounds(event){
  if(event.publishedAt)return [Date.parse(event.publishedAt),Date.parse(event.publishedAt)];
  if(event.publicationWindow)return event.publicationWindow.map(value=>Date.parse(value));
  const hours={ 'before-open':['00:00','09:29'], 'after-close':['16:00','23:59'], 'during-session':['09:30','15:59'], weekend:['00:00','23:59'],unknown:['00:00','23:59'] }[event.session];
  if(!hours)throw new Error('Unknown publication session');
  const nyHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(event.date+'T12:00:00Z')));
  const zone=event.market==='US'?(nyHour===8?'-04:00':'-05:00'):'+08:00';
  return hours.map(hour=>Date.parse(`${event.date}T${hour}:00${zone}`));
}
function firstAffected(row,publishedAt){return row.bars.findIndex(bar=>bar.time+({US:390,HK:390,CN:330}[row.market])*60000>publishedAt);}
module.exports={publicationBounds,firstAffected};
