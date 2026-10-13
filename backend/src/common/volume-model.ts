import calibration from './unified-volume.json';
import { canonicalIndustry, unifiedInstruments, activity } from './unified-market';
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
export function volumeProfile(stock: any, market: string) {
    return calibration.profiles[`${market}|${canonicalIndustry(stock.industry, stock.symbol)}`];
}
export function calibratedVolume(stock: any, market: string, length: number, normal: () => number) {
    const profile = volumeProfile(stock, market);
    if (!profile) return null;
    const minute = clamp(Number(stock.minuteCounter) || 0, 0, length - 1);
    const weights = calibration.marketSeasonality[market];
    const seasonal = weights?.[Math.min(11, Math.floor(minute / length * 12))] || 1;
    const phi = Math.pow(clamp(profile.minutePersistence ?? profile.persistence, 0, .85), 1 / 5);
    const sigma = clamp(profile.minuteNoiseSigma ?? profile.noiseSigma, .2, 1.1);
    const previous = Number(stock.volumeState?.shock) || 0;
    const shock = clamp(phi * previous + sigma * Math.sqrt(1 - phi * phi) * normal(), -2.5, 2.5);
    stock.volumeState = { shock };
    const instrument = unifiedInstruments.get(stock.symbol);
    const minuteSigma = Math.max(.0001, Number(instrument?.volatility || stock.volumeReferenceVolatility || .02) * (instrument?.riskProfile?.intradayFraction ?? .8)
        / Math.sqrt(length) * activity(minute, length, market));
    const standardizedMove = Math.min(6, Math.abs(Number(stock.lastReturn) || 0) / minuteSigma);
    const beta = clamp(profile.minuteVolumeReturnBeta ?? profile.volumeReturnBeta * .5, 0, 1.2);
    // Volume and absolute returns share activity. There is no directional price feedback.
    let eventActivity = 1;
    if (stock.eventVolumeState?.remaining > 0) {
        const pulse = stock.eventVolumeState;
        // Intraday decay is a bounded simulation assumption, not identified by daily event data.
        eventActivity += (pulse.boost - 1) * Math.exp(-(30 - pulse.remaining) / 10);
        pulse.remaining--;
    }
    const multiplier = eventActivity * Math.exp(clamp(shock - .5 * sigma * sigma + beta * (standardizedMove - .8), -3, 3));
    const base = Math.max(1, Number(stock.baseVolume) || 10000);
    return Math.max(0, Math.round(base * seasonal * multiplier));
}

export function eventVolumeIncrement(stock: any, market: string, length: number, before: number, after: number) {
    const profile=volumeProfile(stock,market);
    if(!profile||!(before>0)||!(after>0)||after===before)return 0;
    const instrument=unifiedInstruments.get(stock.symbol);
    const sigma=Math.max(.0001,Number(instrument?.volatility||stock.volumeReferenceVolatility||.02)
        *(instrument?.riskProfile?.intradayFraction??.8)/Math.sqrt(length));
    const z=Math.min(6,Math.abs(Math.log(after/before))/sigma);
    const beta=clamp(profile.minuteVolumeReturnBeta??profile.volumeReturnBeta*.5,0,1.2);
    const weights=calibration.marketSeasonality[market];
    const minute=clamp(Number(stock.minuteCounter)||0,0,length-1);
    const seasonal=weights?.[Math.min(11,Math.floor(minute/length*12))]||1;
    return Math.max(0,Math.round((Number(stock.baseVolume)||10000)*seasonal*Math.min(4,Math.expm1(beta*z))));
}
export function modeledFloatShares(stock: any, market: string, length: number) {
    const profile = volumeProfile(stock, market);
    // Only CN has verified provider turnover. Other markets have no float estimate.
    const turnover = market === 'CN' ? Number(profile?.referenceCnTurnoverPct) : 0;
    return turnover > 0 ? (Number(stock.baseVolume) || 10000) * length / (turnover / 100) : null;
}
