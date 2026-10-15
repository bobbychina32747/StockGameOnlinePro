package game

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"sync"
	"time"
)

type Ledger struct {
	up                *Upstream
	store             *Store
	public, snapshots *Cache
	catalog           map[string]object
}

func newLedger(up *Upstream, store *Store, catalogPath string) (*Ledger, error) {
	data, err := os.ReadFile(catalogPath)
	if err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	var catalog object
	if err = json.Unmarshal(data, &catalog); err != nil {
		return nil, err
	}
	bySymbol := map[string]object{}
	for _, item := range list(catalog["instruments"]) {
		row := obj(item)
		bySymbol[str(row["symbol"])] = row
	}
	if len(bySymbol) == 0 {
		return nil, fmt.Errorf("catalog is empty")
	}
	return &Ledger{up: up, store: store, public: newCache(1), snapshots: newCache(256), catalog: bySymbol}, nil
}
func (ledger *Ledger) publicData(ctx context.Context, token string) (object, error) {
	value, err := ledger.public.get(ctx, "public", 1500*time.Millisecond, func() (any, error) {
		results, err := ledger.parallel(ctx, token, []string{"/api/market/stocks", "/api/market/state", "/api/fund"})
		if err != nil {
			return nil, err
		}
		return object{"stocks": results[0], "state": results[1], "funds": results[2]}, nil
	})
	if err != nil {
		return nil, err
	}
	return obj(value), nil
}
func (ledger *Ledger) parallel(ctx context.Context, token string, paths []string) ([]any, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make([]any, len(paths))
	errs := make([]error, len(paths))
	var group sync.WaitGroup
	for index, path := range paths {
		group.Add(1)
		go func(index int, path string) {
			defer group.Done()
			results[index], errs[index] = ledger.up.call(ctx, "GET", path, token, "", "", nil)
			if errs[index] != nil {
				cancel()
			}
		}(index, path)
	}
	group.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}
func (ledger *Ledger) raw(ctx context.Context, session *Session) (object, error) {
	value, err := ledger.up.call(ctx, "GET", "/api/account/unified?mode="+session.Principal.Market, session.backendToken(), "", "", nil)
	if err != nil {
		return nil, err
	}
	raw := obj(value)
	if str(obj(raw["account"])["id"]) == "" {
		return nil, errorf(503, "账本缺少账户数据")
	}
	return raw, nil
}
func (ledger *Ledger) snapshot(ctx context.Context, session *Session) ([]byte, error) {
	value, err := ledger.snapshots.get(ctx, session.Principal.Owner, time.Second, func() (any, error) {
		var public, raw object
		var publicErr, rawErr error
		var group sync.WaitGroup
		group.Add(2)
		go func() { defer group.Done(); public, publicErr = ledger.publicData(ctx, session.backendToken()) }()
		go func() { defer group.Done(); raw, rawErr = ledger.raw(ctx, session) }()
		group.Wait()
		if publicErr != nil {
			return nil, publicErr
		}
		if rawErr != nil {
			return nil, rawErr
		}
		return json.Marshal(ledger.adapt(raw, session.Principal, list(public["stocks"]), obj(public["state"]), list(public["funds"])))
	})
	if err != nil {
		return nil, err
	}
	return value.([]byte), nil
}
func (ledger *Ledger) stock(ctx context.Context, session *Session, symbol string) (object, error) {
	public, err := ledger.publicData(ctx, session.backendToken())
	if err != nil {
		return nil, err
	}
	for _, item := range list(public["stocks"]) {
		row := obj(item)
		if row["symbol"] == symbol && row["market"] == session.Principal.Market {
			return row, nil
		}
	}
	return nil, errorf(400, "不能查看或交易其他区服标的")
}
func (ledger *Ledger) history(ctx context.Context, session *Session, symbol, interval string, adjusted bool) (any, error) {
	stock, err := ledger.stock(ctx, session, symbol)
	if err != nil {
		return nil, err
	}
	timeframe := map[string]string{"1m": "1min", "5m": "5min", "60m": "60min", "day": "daily", "week": "weekly", "month": "monthly"}[interval]
	if timeframe == "" {
		return nil, errorf(400, "周期无效")
	}
	value, err := ledger.up.call(ctx, "GET", "/api/market/klines?symbol="+url.QueryEscape(symbol)+"&timeframe="+timeframe, session.backendToken(), "", "", nil)
	if err != nil {
		return nil, err
	}
	bars := make([]any, 0, len(list(value)))
	for _, item := range list(value) {
		bar := obj(item)
		stamp := timestamp(bar["time"])
		day := math.Floor(float64(stamp-time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()) / 86400000)
		factor := 1.0
		if adjusted {
			for _, item := range list(stock["adjustmentSeries"]) {
				row := obj(item)
				if num(row["day"]) <= day {
					factor = nonzero(num(row["factor"]), 1)
				}
			}
		}
		bars = append(bars, object{"time": stamp, "day": day, "open": math.Floor(float64(cents(bar["open"]))*factor + .5), "close": math.Floor(float64(cents(bar["close"]))*factor + .5), "high": math.Floor(float64(cents(bar["high"]))*factor + .5), "low": math.Floor(float64(cents(bar["low"]))*factor + .5), "volume": num(bar["volume"])})
	}
	return bars, nil
}
func mapOrder(row object, day float64) object {
	quantity, filled := num(row["quantity"]), num(row["filledQty"])
	status := row["status"]
	if status == "open" {
		status = "pending"
	}
	order := object{"id": row["id"], "commandId": fallback(row["clientOrderId"], row["id"]), "accountId": row["accountId"], "symbol": row["symbol"], "side": row["side"], "type": row["type"], "quantity": quantity, "remaining": math.Max(0, quantity-filled), "filled": filled, "averagePrice": cents(row["avgFillPrice"]), "visible": fallback(row["displayQty"], math.Max(0, quantity-filled)), "sequence": timestamp(row["createdAt"]), "createdDay": day, "status": status, "triggered": row["triggerLog"] != nil && row["triggerLog"] != "", "postClose": truth(row["postClose"])}
	for _, key := range []string{"price", "triggerPrice"} {
		if row[key] != nil {
			order[key] = cents(row[key])
		}
	}
	if row["displayQty"] != nil {
		order["displayQuantity"] = row["displayQty"]
	}
	if row["rejectReason"] != nil {
		order["error"] = row["rejectReason"]
	}
	return order
}
func (ledger *Ledger) instruments(stocks []any, market string) ([]any, object) {
	instruments := []any{}
	quotes := object{}
	for _, item := range stocks {
		row := obj(item)
		if row["market"] != market {
			continue
		}
		symbol := str(row["symbol"])
		base := ledger.catalog[symbol]
		instrument := object{}
		for key, value := range base {
			instrument[key] = value
		}
		for _, key := range []string{"symbol", "name", "industry", "description"} {
			if row[key] != nil {
				instrument[key] = row[key]
			}
		}
		instrument["market"] = market
		instrument["code"] = fallback(row["code"], symbol)
		if row["listDate"] != nil {
			instrument["listedAt"] = row["listDate"]
		}
		instrument["initialPrice"] = fallback(base["initialPrice"], cents(row["price"]))
		instrument["volatility"] = fallback(base["volatility"], .02)
		instruments = append(instruments, instrument)
		price := float64(cents(row["price"]))
		change := num(row["changePct"]) / 100
		previous := nonzero(float64(cents(row["previousClose"])), math.Floor(price/(1+change)+.5))
		quote := object{"symbol": symbol, "price": price, "previousClose": previous, "fairValue": nonzero(float64(cents(row["intrinsic"])), price), "open": nonzero(float64(cents(row["dayOpen"])), price), "high": nonzero(float64(cents(row["dayHigh"])), price), "low": nonzero(float64(cents(row["dayLow"])), price), "volume": num(row["dayVolume"]), "turnover": cents(row["dayAmount"]), "modeledTurnoverPct": row["modeledTurnoverPct"], "relativeVolume": num(row["relativeVolume"]), "priceLimits": nil, "momentum": 0, "bubble": 0, "earningsGrowth": num(obj(row["fundamentals"])["consensusGrowth"]), "pe": 0, "dividendFactor": nonzero(num(row["adjFactor"]), 1), "change": change}
		if row["volumeSource"] != nil {
			quote["volumeSource"] = row["volumeSource"]
		}
		if row["priceLimits"] != nil {
			band := obj(row["priceLimits"])
			quote["priceLimits"] = object{"up": cents(band["up"]), "down": cents(band["down"])}
		}
		quotes[symbol] = quote
	}
	return instruments, quotes
}
func (ledger *Ledger) positions(raw object, quotes object, market string) ([]any, float64) {
	positions := []any{}
	value := 0.0
	for _, item := range list(raw["positions"]) {
		row := obj(item)
		quantity, short := num(row["longQty"]), num(row["shortQty"])
		if quantity == 0 && short == 0 {
			continue
		}
		price := num(obj(quotes[str(row["symbol"])])["price"])
		if price == 0 {
			price = float64(cents(nonzero(num(row["longCost"]), num(row["shortCost"]))))
		}
		cost := float64(cents(row["longCost"]))
		sellable := quantity
		if market == "CN" {
			sellable = math.Max(0, quantity-num(row["boughtToday"]))
		}
		positions = append(positions, object{"symbol": row["symbol"], "lots": []any{object{"quantity": quantity, "cost": cost, "boughtDay": fallback(row["boughtDay"], 0), "debt": 0}}, "quantity": quantity, "shortQuantity": short, "shortProceeds": float64(cents(row["shortCost"])) * short, "collateral": 0, "sellable": sellable, "cost": cost, "pnl": (price-cost)*quantity + (float64(cents(row["shortCost"]))-price)*short})
		valuationPrice := num(obj(quotes[str(row["symbol"])])["price"])
		if valuationPrice == 0 {
			valuationPrice = cost
		}
		value += (quantity - short) * valuationPrice
	}
	return positions, value
}
func fundByID(funds []any, id string) object {
	for _, item := range funds {
		row := obj(item)
		if row["id"] == id || row["fundId"] == id {
			return row
		}
	}
	return object{}
}
func fxRate(raw object, market string) float64 {
	if market == "CN" {
		return 1
	}
	return nonzero(num(obj(raw["fxRates"])[market]), 1)
}
func (ledger *Ledger) account(raw object, principal Principal, quotes object, funds []any, orders []any) object {
	account := obj(raw["account"])
	positions, value := ledger.positions(raw, quotes, principal.Market)
	fundValue := 0.0
	for _, item := range list(raw["funds"]) {
		row := obj(item)
		fundValue += num(row["shares"]) * num(fundByID(funds, str(row["fundId"]))["nav"])
	}
	fundValue /= fxRate(raw, principal.Market)
	if raw["positionValue"] != nil {
		value = float64(cents(raw["positionValue"]))
	}
	equity := float64(cents(account["cash"])) + value + float64(cents(account["shortCollateral"])-cents(account["borrowed"])+cents(fundValue))
	initial := float64(cents(account["initialEquity"]))
	totalReturn := equity/math.Max(1, initial) - 1
	reserved := 0.0
	for _, item := range orders {
		order := obj(item)
		if (order["status"] == "pending" || order["status"] == "partial") && order["side"] == "buy" {
			reserved += num(order["remaining"]) * num(fallback(order["price"], obj(quotes[str(order["symbol"])])["price"]))
		}
	}
	achievements := []any{}
	for _, item := range list(raw["achievements"]) {
		achievements = append(achievements, obj(item)["code"])
	}
	history := []any{}
	for _, item := range list(raw["history"]) {
		row := obj(item)
		history = append(history, object{"day": row["day"], "equity": cents(row["equity"])})
	}
	metrics := obj(raw["metrics"])
	return object{"id": account["id"], "owner": principal.Owner, "name": principal.Name, "market": principal.Market, "actor": "player", "cash": cents(account["cash"]), "debt": cents(account["borrowed"]), "collateral": cents(account["shortCollateral"]), "leverage": nonzero(num(account["leverage"]), 1), "initialEquity": initial, "positions": positions, "funds": object{"money": num(fundByID(list(raw["funds"]), "fund-2")["shares"]) * 100, "etf": num(fundByID(list(raw["funds"]), "fund-1")["shares"]) * 100}, "achievements": achievements, "equityHistory": history, "seasonPoints": num(account["seasonPoints"]), "adaptation": 0, "lastEquity": cents(account["dayStartEquity"]), "available": cents(account["cash"]), "reserved": reserved, "equity": equity, "totalReturn": totalReturn, "marginRatio": nil, "metrics": object{"maxDrawdown": num(metrics["maxDrawdown"]), "sharpe": num(metrics["sharpeRatio"]), "volatility": num(metrics["volatility"]), "profitableDays": 0, "days": len(list(raw["history"])), "totalReturn": totalReturn}}
}
func marketViews(state, raw object, funds []any, day float64) (object, object) {
	views, clocks := object{}, object{}
	for _, market := range markets {
		source := obj(fallback(obj(state["markets"])[market], state))
		clock := object{}
		for key, value := range obj(source["clock"]) {
			clock[key] = value
		}
		clock["day"] = num(source["gameDay"])
		clock["date"] = fallback(clock["date"], time.Now().UTC().Format("2006-01-02"))
		clock["minute"] = fallback(clock["minute"], 0)
		phase := "closed"
		if truth(source["isTradingTime"]) {
			phase = "continuous"
		} else if truth(source["isPostCloseTrading"]) {
			phase = "post-close"
		}
		clock["phase"] = fallback(clock["phase"], phase)
		if truth(state["offHoursTrading"]) {
			clock["phase"] = "continuous"
		}
		clock["settledDay"] = num(source["gameDay"]) - 1
		clock["lastRealMinute"] = fallback(clock["now"], "")
		sectors := object{}
		for industry, phase := range obj(source["industryCycles"]) {
			cycle := 0
			for index, item := range []string{"expansion", "peak", "contraction", "trough"} {
				if phase == item {
					cycle = index
				}
			}
			sectors[industry] = object{"cycle": cycle, "trend": 0, "heat": 0}
		}
		views[market] = object{"clock": clock, "sentiment": num(obj(source["factors"])["市场情绪"]), "rate": .025, "inflation": 0, "growth": 0, "sectors": sectors, "lastNavDay": day, "fundNav": object{"money": math.Floor(num(fundByID(funds, "fund-2")["nav"])/fxRate(raw, market)*10000 + .5), "etf": math.Floor(num(fundByID(funds, "fund-1")["nav"])/fxRate(raw, market)*10000 + .5), "basket": 0, "dividend": 0}}
		clocks[market] = clock
	}
	return views, clocks
}
func eventsFor(state object, market string, day float64) []any {
	events := []any{}
	for _, item := range list(state["news"]) {
		row := obj(item)
		if row["market"] != market {
			continue
		}
		if len(events) >= 60 {
			break
		}
		index := len(events)
		impact := 0
		if row["type"] == "bullish" {
			impact = 1
		} else if row["type"] == "bearish" {
			impact = -1
		}
		events = append(events, object{"id": fmt.Sprintf("news:%s:%d", str(row["publishedAt"]), index), "sequence": index, "market": market, "day": day, "kind": fallback(row["type"], "news"), "title": row["title"], "detail": fallback(row["description"], ""), "impact": impact, "time": nonzero(float64(timestamp(row["publishedAt"])), float64(time.Now().UnixMilli()))})
	}
	topics := fallback(obj(obj(state["markets"])[market])["hotTopics"], state["hotTopics"])
	for index, item := range list(topics) {
		row := obj(item)
		title, detail := item, item
		if _, ok := item.(string); !ok {
			title = fallback(row["title"], fallback(row["topic"], str(row["industry"])+"行业热点"))
			detail = fallback(row["content"], fallback(row["description"], fmt.Sprintf("热度 %.0f%% · 持续 %s 个交易日", num(row["strength"])*100, numberString(row["duration"]))))
		}
		events = append(events, object{"id": fmt.Sprintf("topic:%d:%s", index, numberString(day)), "sequence": index, "market": market, "day": day, "kind": "topic", "title": title, "detail": detail, "impact": num(row["impact"]), "time": time.Now().UnixMilli()})
	}
	return events
}
func (ledger *Ledger) adapt(raw object, principal Principal, stocks []any, state object, funds []any) object {
	day := num(fallback(obj(obj(state["markets"])[principal.Market])["gameDay"], state["gameDay"]))
	instruments, quotes := ledger.instruments(stocks, principal.Market)
	orders := []any{}
	for _, item := range list(raw["orders"]) {
		orders = append(orders, mapOrder(obj(item), day))
	}
	account := ledger.account(raw, principal, quotes, funds, orders)
	views, clocks := marketViews(state, raw, funds, day)
	indexValue, indexChange := 0.0, 0.0
	advancing := 0
	for _, item := range instruments {
		row := obj(item)
		quote := obj(quotes[str(row["symbol"])])
		indexValue += num(quote["price"]) / math.Max(1, num(row["initialPrice"]))
		indexChange += num(quote["change"])
		if num(quote["change"]) > 0 {
			advancing++
		}
	}
	if len(instruments) > 0 {
		indexValue = indexValue / float64(len(instruments)) * 1000
		indexChange /= float64(len(instruments))
	} else {
		indexValue = 1000
	}
	accounts := object{"CN": nil, "HK": nil, "US": nil}
	accounts[principal.Market] = account
	reviews := []any{}
	for _, item := range list(raw["reviews"]) {
		row := obj(item)
		if row["market"] == nil || row["market"] == "" || row["market"] == principal.Market {
			reviews = append(reviews, row)
		}
	}
	formal := object{"ledger": "legacy-authoritative", "tier": obj(raw["account"])["tier"], "metrics": raw["metrics"], "reviews": reviews, "achievements": raw["achievements"], "fundHoldings": raw["funds"], "funds": funds, "tickIntervalMs": state["tickIntervalMs"], "offHoursTrading": state["offHoursTrading"]}
	return object{"protocolVersion": 2, "kind": "snapshot", "worldVersion": raw["ledgerVersion"], "sequence": raw["ledgerVersion"], "mode": "real", "simulatedAt": clocks, "instruments": instruments, "quotes": quotes, "markets": views, "indices": []any{object{"market": principal.Market, "value": indexValue, "change": indexChange, "advancing": advancing, "count": len(instruments)}}, "accounts": accounts, "orders": orders, "trades": []any{}, "events": eventsFor(state, principal.Market, day), "seasons": []any{}, "rankings": []any{}, "formal": formal}
}
