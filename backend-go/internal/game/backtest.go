package game

import (
	"context"
	"time"
)

func serverTime() int64 { return time.Now().UnixMilli() }

// Keep the existing deterministic backtest engine and results during the API migration.
// The compute-only endpoint has no access to player accounts or live trading writes.
func (server *Server) backtest(ctx context.Context, session *Session, body object) (any, error) {
	symbol, strategy := str(body["symbol"]), str(body["strategy"])
	if !member(strategy, "ma", "rsi", "momentum") {
		return nil, errorf(400, "回测策略必须为 MA、RSI 或动量")
	}
	if _, err := server.ledger.stock(ctx, session, symbol); err != nil {
		return nil, err
	}
	return server.up.call(ctx, "POST", "/api/market/backtest-v2", session.backendToken(), "", "", object{"symbol": symbol, "strategy": strategy})
}
