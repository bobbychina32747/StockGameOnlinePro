const { validateCalendar, checkCalendar } = require('../scripts/calendar-data.cjs');
const snapshot = require('../src/common/data/exchange-calendar.json');
const { isExchangeTradingDate, exchangeSessions, realMarketClock, completedTradingDates } = require('../dist/src/common/data/trading-calendar');
test('calendar copies are current and malformed updates cannot be accepted', () => {
    expect(checkCalendar()).toBeUndefined();
    const copy = () => JSON.parse(JSON.stringify(snapshot));
    let data = copy();
    data.markets.US.years['2027'].halfDays.push('2027-02-30');
    expect(() => validateCalendar(data)).toThrow();
    data = copy();
    data.markets.HK.years['2027'].halfDays.push('2027-02-08');
    data.markets.HK.years['2027'].halfDays.sort();
    expect(() => validateCalendar(data)).toThrow('overlaps');
    data = copy();
    data.markets.CN.years['2026'].sources = ['https://example.test/calendar'];
    expect(() => validateCalendar(data)).toThrow('official');
});
test('Hong Kong 2027 lunar eve is half day, not closed; corrected autumn dates match source', () => {
    expect(isExchangeTradingDate('HK', '2027-02-05')).toBe(true);
    expect(exchangeSessions('HK', '2027-02-05')).toEqual([[570, 720]]);
    expect(isExchangeTradingDate('HK', '2027-09-16')).toBe(false);
    expect(isExchangeTradingDate('HK', '2027-09-24')).toBe(true);
    expect(isExchangeTradingDate('HK', '2027-10-08')).toBe(false);
});
test('NYSE 2027 early close is 13:00 Eastern and 2028 New Year is not observed on Friday', () => {
    expect(exchangeSessions('US', '2027-11-26')).toEqual([[570, 780]]);
    expect(realMarketClock('US', new Date('2027-11-26T18:00:00Z')).minute).toBeNull();
    expect(isExchangeTradingDate('US', '2027-12-31')).toBe(true);
    expect(isExchangeTradingDate('US', '2028-01-03')).toBe(true);
});
test('real-time dates outside verified coverage fail closed rather than treating missing arrays as open', () => {
    const clock = realMarketClock('CN', new Date('2027-02-10T02:00:00Z'));
    expect(clock.calendar.available).toBe(false);
    expect(clock.phase).toBe('closed');
    expect(clock.minute).toBeNull();
    expect(isExchangeTradingDate('US', '2027-02-30')).toBe(false);
});

test('history uses completed exchange sessions, including half days and local dates', () => {
    // Thanksgiving is closed; Black Friday ends at 13:00 Eastern.
    expect(completedTradingDates('US', 2, new Date('2026-11-27T17:59:00Z'))).toEqual(['2026-11-24', '2026-11-25']);
    expect(completedTradingDates('US', 2, new Date('2026-11-27T18:00:00Z'))).toEqual(['2026-11-25', '2026-11-27']);
    expect(completedTradingDates('CN', 1, new Date('2026-11-24T06:59:00Z'))).toEqual(['2026-11-23']);
    expect(completedTradingDates('CN', 1, new Date('2026-11-24T07:00:00Z'))).toEqual(['2026-11-24']);
    expect(() => completedTradingDates('US', 0)).toThrow(RangeError);
    expect(() => completedTradingDates('CN', 365, new Date('2025-01-02T08:00:00Z'))).toThrow('coverage');
});
