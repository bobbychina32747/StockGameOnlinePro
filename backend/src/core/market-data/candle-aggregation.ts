const periodMs = 5 * 60000;
function valid(bar: any) {
    return Number.isFinite(new Date(bar.time).getTime()) &&
        [bar.open, bar.close, bar.high, bar.low].every(v => Number.isFinite(Number(v)) && Number(v) > 0) &&
        Number(bar.high) >= Math.max(Number(bar.open), Number(bar.close)) &&
        Number(bar.low) <= Math.min(Number(bar.open), Number(bar.close));
}
export function fiveMinuteHistory(existing: any[], minutes: any[]) {
    const result = new Map<number, any>();
    for (const bar of existing) if (valid(bar)) result.set(new Date(bar.time).getTime(), bar);
    const ordered = new Map<number, any>();
    for (const bar of minutes) if (valid(bar)) ordered.set(new Date(bar.time).getTime(), bar);
    const sorted = [...ordered].sort((a,b) => a[0] - b[0]);
    const groups = new Map<number, any>();
    for (const [time, bar] of sorted) {
        const start = Math.floor(time / periodMs) * periodMs;
        let group = groups.get(start);
        if (!group) {
            group = {time:new Date(start),open:Number(bar.open),close:Number(bar.close),high:Number(bar.high),low:Number(bar.low),volume:0,firstTime:time};
            groups.set(start,group);
        }
        group.close=Number(bar.close);group.high=Math.max(group.high,Number(bar.high));group.low=Math.min(group.low,Number(bar.low));
        group.volume += Math.max(0,Number(bar.volume)||0);
    }
    for (const [start, group] of groups) {
        // A hot-cache boundary may begin midway through an older complete candle.
        if (group.firstTime !== start && result.has(start)) continue;
        const {firstTime,...bar}=group;result.set(start,bar);
    }
    return [...result].sort((a,b) => a[0]-b[0]).map(([_,bar])=>bar);
}
