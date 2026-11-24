const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const backend = path.resolve(__dirname, '../src/common/data'), frontend = path.join(root, 'frontend/src/data');
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
function validateCalendar(data) {
    if (data?.schemaVersion !== 1 || !isDate(data.updatedAt))
        throw Error('Invalid calendar version or update date');
    if (!data.markets || Object.keys(data.markets).sort().join(',') !== 'CN,HK,US')
        throw Error('Calendar must declare CN, HK and US');
    for (const [market, entry] of Object.entries(data.markets)) {
        if (!entry.years || typeof entry.years !== 'object' || Array.isArray(entry.years) || !Object.keys(entry.years).length)
            throw Error('Missing calendar years: ' + market);
        for (const [year, record] of Object.entries(entry.years)) {
            if (!/^\d{4}$/.test(year) || !['verified', 'historical', 'rule-derived'].includes(record.confidence))
                throw Error('Invalid year/confidence: ' + market + '/' + year);
            for (const key of ['holidays', 'halfDays']) {
                const list = record[key];
                if (!Array.isArray(list) || list.some(date => !isDate(date) || !date.startsWith(year + '-')) || new Set(list).size !== list.length || list.join(',') !== [...list].sort().join(','))
                    throw Error('Invalid, duplicate or unsorted ' + key + ': ' + market + '/' + year);
            }
            if (record.halfDays.some(date => record.holidays.includes(date) || [0, 6].includes(new Date(date + 'T12:00:00Z').getUTCDay())))
                throw Error('Half day overlaps closure/weekend: ' + market + '/' + year);
            if (!Array.isArray(record.sources) || !record.sources.length)
                throw Error('Missing official sources: ' + market + '/' + year);
            for (const link of record.sources) {
                const url = new URL(link), allowed = ['sse.com.cn', 'szse.cn', 'hkex.com.hk', 'nyse.com', 'gov.hk'];
                if (url.protocol !== 'https:' || url.username || url.password || !allowed.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
                    throw Error('Calendar source is not an approved official origin');
            }
        }
    }
    return data;
}
function checkCalendar(backendOnly = false) {
    validateCalendar(JSON.parse(fs.readFileSync(path.join(backend, 'exchange-calendar.json'), 'utf8')));
    if (backendOnly) return;
    for (const file of ['exchange-calendar.json', 'trading-calendar.ts'])
        if (!fs.readFileSync(path.join(backend, file)).equals(fs.readFileSync(path.join(frontend, file))))
            throw Error('Calendar copies differ: ' + file);
}
module.exports = { validateCalendar, checkCalendar };
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] === '--update' && args.length === 2) {
        const data = validateCalendar(JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'))), text = JSON.stringify(data, null, 2) + '\n';
        if (!fs.existsSync(frontend)) throw Error('Calendar updates require the complete repository with its frontend data directory');
        fs.writeFileSync(path.join(backend, 'exchange-calendar.json'), text, 'utf8');
        fs.writeFileSync(path.join(frontend, 'exchange-calendar.json'), text, 'utf8');
    }
    else if (args.length > 0 && !(args.length === 1 && ['--check','--schema-only'].includes(args[0])))
        throw Error('Usage: calendar-data.cjs --check | --schema-only | --update <reviewed-json>');
    const backendOnly = args[0] === '--schema-only';
    checkCalendar(backendOnly);
    console.log(backendOnly ? 'Backend calendar schema and provenance passed' : 'Calendar schema, provenance and frontend copies passed');
}
