package game

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

func (server *Server) readRoute(req *http.Request, session *Session, path string) (any, error) {
	ctx := req.Context()
	token := session.backendToken()
	market := session.Principal.Market
	switch {
	case path == "state":
		return server.ledger.snapshot(ctx, session)
	case strings.HasPrefix(path, "commands/"):
		return server.ledger.result(session.Principal.Owner, strings.TrimPrefix(path, "commands/"))
	case strings.HasPrefix(path, "history/"):
		interval := req.URL.Query().Get("interval")
		if interval == "" {
			interval = "day"
		}
		return server.ledger.history(ctx, session, strings.TrimPrefix(path, "history/"), interval, req.URL.Query().Get("adjusted") == "true")
	case strings.HasPrefix(path, "book/"):
		return server.book(ctx, session, strings.TrimPrefix(path, "book/"))
	case strings.HasPrefix(path, "activity/"):
		return server.activity(ctx, session, strings.TrimPrefix(path, "activity/"))
	case strings.HasPrefix(path, "research/"):
		symbol := strings.TrimPrefix(path, "research/")
		if _, err := server.ledger.stock(ctx, session, symbol); err != nil {
			return nil, err
		}
		values, err := server.ledger.parallel(ctx, token, []string{"/api/market/reports?symbol=" + url.QueryEscape(symbol), "/api/market/flow-signals?symbol=" + url.QueryEscape(symbol)})
		if err != nil {
			return nil, err
		}
		return object{"reports": values[0], "flow": values[1]}, nil
	case path == "competition":
		values, err := server.ledger.parallel(ctx, token, []string{"/api/season/current", "/api/season/leaderboard?market=" + market, "/api/season/history", "/api/season/schedule", "/api/market/ai-opponents"})
		if err != nil {
			return nil, err
		}
		opponents := []any{}
		for _, item := range list(values[4]) {
			if obj(item)["market"] == market {
				opponents = append(opponents, item)
			}
		}
		return object{"current": values[0], "leaderboard": values[1], "history": values[2], "schedule": values[3], "opponents": opponents}, nil
	}
	return nil, errorf(404, "接口不存在")
}
func (server *Server) book(ctx context.Context, session *Session, symbol string) (any, error) {
	if _, err := server.ledger.stock(ctx, session, symbol); err != nil {
		return nil, err
	}
	value, err := server.up.call(ctx, "GET", "/api/market/orderbook?symbol="+url.QueryEscape(symbol), session.backendToken(), "", "", nil)
	if err != nil {
		return nil, err
	}
	book := obj(value)
	result := object{}
	for _, side := range []string{"bids", "asks"} {
		levels := []any{}
		for _, item := range list(book[side]) {
			row := obj(item)
			quantity := fallback(row["quantity"], fallback(row["qty"], fallback(row["size"], row["volume"])))
			levels = append(levels, object{"price": cents(row["price"]), "quantity": quantity})
		}
		result[side] = levels
	}
	result["worldVersion"] = serverTime()
	return result, nil
}
func (server *Server) activity(ctx context.Context, session *Session, table string) (any, error) {
	if !member(table, "orders", "trades", "ledger") {
		return nil, errorf(400, "记录类型无效")
	}
	raw, err := server.ledger.raw(ctx, session)
	if err != nil {
		return nil, err
	}
	result := []any{}
	if table == "orders" {
		for _, item := range list(raw["orders"]) {
			row := obj(item)
			row["averagePrice"] = cents(row["avgFillPrice"])
			if row["price"] != nil {
				row["price"] = cents(row["price"])
			}
			result = append(result, row)
		}
		return result, nil
	}
	for _, item := range list(raw["transactions"]) {
		row := obj(item)
		direction := 1.0
		if member(str(row["side"]), "buy", "cover") {
			direction = -1
		}
		row["kind"] = row["side"]
		row["reference"] = row["orderId"]
		row["price"] = cents(row["price"])
		row["amount"] = cents(direction*num(row["turnover"]) - num(row["totalFees"]))
		row["currency"] = session.Principal.Market
		result = append(result, row)
	}
	return result, nil
}
