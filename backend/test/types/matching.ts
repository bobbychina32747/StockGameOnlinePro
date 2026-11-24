import { MatchingEngine } from '../../src/core/trading-engine/matching-engine';

const engine = new MatchingEngine();
engine.prices.set('U1', 10);
engine.orderBooks.set('U1', { bids: [], asks: [{ price: 10, size: 100 }] });
engine.setVirtualFillHook(fill => { fill.price.toFixed(2); });

// These must remain compile errors; removing the type contract fails this check.
// @ts-expect-error Unknown state must not be accepted by a class index signature.
engine.nonexistentBook = new Map();
// @ts-expect-error Dynamic access also rejects undeclared state under strict checks.
engine['misspelledPrices'].set('U1', 10);
// @ts-expect-error Prices must be numeric.
engine.prices.set('U1', '10');
// @ts-expect-error Synthetic liquidity uses size; qty is a resting-order field.
engine.orderBooks.set('U1', { bids: [], asks: [{ price: 10, qty: 100 }] });
// @ts-expect-error Callback payloads contain only the declared virtual-fill contract.
engine.setVirtualFillHook(fill => fill.arbitraryField);
