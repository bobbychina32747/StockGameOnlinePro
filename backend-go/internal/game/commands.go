package game

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"time"
)

var idempotencyKey = regexp.MustCompile(`^[A-Za-z0-9_:-]{8,100}$`)

func member(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}
func integer(value any, min, max float64) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number == math.Floor(number) && number >= min && number <= max
}
func orderInput(body object) (object, error) {
	input := obj(body["input"])
	if str(input["symbol"]) == "" || len(str(input["symbol"])) > 100 || !member(str(input["side"]), "buy", "sell", "short", "cover") || !member(str(input["type"]), "market", "limit", "stop", "stop-limit", "fok", "ioc", "iceberg") || !integer(input["quantity"], 1, 1000000) {
		return nil, errorf(400, "委托参数无效")
	}
	result := object{"symbol": input["symbol"], "side": input["side"], "type": input["type"], "quantity": input["quantity"]}
	for _, field := range []string{"price", "triggerPrice"} {
		if input[field] != nil {
			if !integer(input[field], 1, 100000000) {
				return nil, errorf(400, "价格必须是有效的分单位整数")
			}
			result[field] = num(input[field]) / 100
		}
	}
	if input["displayQuantity"] != nil {
		if !integer(input["displayQuantity"], 1, num(input["quantity"])-1) {
			return nil, errorf(400, "冰山显示数量无效")
		}
		result["displayQty"] = input["displayQuantity"]
	}
	return result, nil
}
func (ledger *Ledger) routeCommand(ctx context.Context, session *Session, body object, key string) (string, string, any, error) {
	mode := "?mode=" + session.Principal.Market
	if body["market"] != nil && body["market"] != session.Principal.Market {
		return "", "", nil, errorf(400, "角色区服不可切换")
	}
	switch body["kind"] {
	case "order":
		input, err := orderInput(body)
		if err != nil {
			return "", "", nil, err
		}
		if _, err = ledger.stock(ctx, session, str(input["symbol"])); err != nil {
			return "", "", nil, err
		}
		input["clientOrderId"] = digest(key)
		return "/api/trading/order" + mode, "POST", input, nil
	case "cancel":
		id := str(body["orderId"])
		if id == "" || len(id) > 100 {
			return "", "", nil, errorf(400, "订单无效")
		}
		return "/api/trading/order/" + url.PathEscape(id) + mode, "DELETE", nil, nil
	case "leverage":
		leverage, ok := body["leverage"].(float64)
		if !ok || leverage < 1 || leverage > 3 {
			return "", "", nil, errorf(400, "杠杆必须为1–3")
		}
		return "/api/account/leverage" + mode, "POST", object{"leverage": leverage}, nil
	case "reset":
		return "/api/account/reset" + mode, "POST", object{"preset": "散户"}, nil
	case "season":
		return "/api/season/enroll", "POST", object{}, nil
	case "fund":
		if !member(str(body["fund"]), "money", "etf") || !member(str(body["action"]), "buy", "sell") || !integer(body["amount"], 1, 9007199254740991) {
			return "", "", nil, errorf(400, "基金交易参数无效")
		}
		fund, action, field := "fund-2", "subscribe", "amount"
		if body["fund"] == "etf" {
			fund = "fund-1"
		}
		if body["action"] == "sell" {
			action = "redeem"
			field = "shares"
		}
		return "/api/fund/" + fund + "/" + action + mode + "&" + field + "=" + numberString(num(body["amount"])/100), "POST", object{}, nil
	}
	return "", "", nil, errorf(400, "正式版不支持该操作或跨区划转")
}
func (ledger *Ledger) result(owner, key string) (any, error) {
	var value sql.NullString
	err := ledger.store.db.QueryRow("SELECT result FROM formal_commands WHERE owner=? AND key=?", owner, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return object{"found": false, "pending": false}, nil
	}
	if err != nil {
		return nil, errorf(503, "无法读取原操作结果")
	}
	if !value.Valid || value.String == "" {
		return object{"found": false, "pending": true}, nil
	}
	var result any
	if err = json.Unmarshal([]byte(value.String), &result); err != nil {
		return nil, errorf(503, "原操作结果记录损坏，请核对流水")
	}
	return object{"found": true, "result": result}, nil
}
func (ledger *Ledger) existing(owner, key, body string) (any, bool, error) {
	var previous string
	var value sql.NullString
	err := ledger.store.db.QueryRow("SELECT body,result FROM formal_commands WHERE owner=? AND key=?", owner, key).Scan(&previous, &value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errorf(503, "无法读取原操作记录")
	}
	canonicalPrevious, err := canonical([]byte(previous))
	if err != nil {
		return nil, true, errorf(503, "原操作记录损坏，请核对流水")
	}
	if canonicalPrevious != body {
		return nil, true, errorf(400, "幂等键已用于其他操作")
	}
	if !value.Valid || value.String == "" {
		return nil, true, errorf(503, "原操作仍在处理或结果未知，请在资金流水核对；系统不会重复扣款")
	}
	var result any
	if err = json.Unmarshal([]byte(value.String), &result); err != nil {
		return nil, true, errorf(503, "原操作结果记录损坏")
	}
	return result, true, nil
}
func (ledger *Ledger) command(ctx context.Context, session *Session, body object, key string) (any, error) {
	if !idempotencyKey.MatchString(key) {
		return nil, errorf(400, "需要有效的幂等键")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, errorf(400, "命令数据无效")
	}
	canonicalBody := string(encoded)
	owner := session.Principal.Owner
	if result, exists, err := ledger.existing(owner, key, canonicalBody); exists || err != nil {
		return result, err
	}
	path, method, payload, err := ledger.routeCommand(ctx, session, body, key)
	if err != nil {
		return nil, err
	}
	inserted, err := ledger.store.db.Exec("INSERT OR IGNORE INTO formal_commands(owner,key,body,state) VALUES(?,?,?,'pending')", owner, key, canonicalBody)
	if err != nil {
		return nil, errorf(503, "无法记录操作，未向账本发送")
	}
	changed, err := inserted.RowsAffected()
	if err != nil {
		return nil, errorf(503, "操作记录状态未知")
	}
	if changed == 0 {
		result, _, err := ledger.existing(owner, key, canonicalBody)
		return result, err
	}
	data, forwardErr := ledger.up.call(ctx, method, path, session.backendToken(), "", "", payload)
	result := object{"version": time.Now().UnixMilli()}
	if forwardErr != nil {
		var api *APIError
		if !errors.As(forwardErr, &api) || api.Status >= 500 {
			return nil, forwardErr
		}
		result["success"] = false
		result["error"] = api.Message
	} else {
		row := obj(data)
		result["success"] = row["success"] != false
		result["data"] = data
		if row["error"] != nil {
			result["error"] = row["error"]
		}
		if row["order"] != nil {
			result["order"] = mapOrder(obj(row["order"]), 0)
		}
	}
	encoded, err = json.Marshal(result)
	if err != nil {
		return nil, errorf(503, "原操作可能已完成，结果记录失败，请核对流水")
	}
	if _, err = ledger.store.db.Exec("UPDATE formal_commands SET state='complete',result=? WHERE owner=? AND key=?", string(encoded), owner, key); err != nil {
		return nil, errorf(503, "原操作可能已完成，结果记录失败，请核对流水")
	}
	ledger.snapshots.invalidate(owner)
	return result, nil
}
func (ledger *Ledger) estimate(ctx context.Context, session *Session, body object) (any, error) {
	if body["market"] != session.Principal.Market {
		return nil, errorf(400, "角色区服不可切换")
	}
	input, err := orderInput(body)
	if err != nil {
		return nil, err
	}
	symbol := str(input["symbol"])
	if _, err = ledger.stock(ctx, session, symbol); err != nil {
		return nil, err
	}
	value, err := ledger.up.call(ctx, "POST", "/api/trading/estimate?mode="+session.Principal.Market, session.backendToken(), "", "", input)
	if err != nil {
		return nil, err
	}
	validation := obj(value)
	if !truth(validation["valid"]) {
		return validation, nil
	}
	snapshot, err := ledger.snapshot(ctx, session)
	if err != nil {
		return nil, err
	}
	var state object
	if err = json.Unmarshal(snapshot, &state); err != nil {
		return nil, err
	}
	held := obj(obj(state["accounts"])[session.Principal.Market])
	sellable := 0.0
	for _, item := range list(held["positions"]) {
		position := obj(item)
		if position["symbol"] == symbol {
			sellable = num(position["sellable"])
		}
	}
	price := nonzero(float64(cents(validation["price"])), num(obj(obj(state["quotes"])[symbol])["price"]))
	return object{"valid": true, "price": price, "quantity": input["quantity"], "filled": 0, "total": price * num(input["quantity"]), "fee": cents(obj(validation["fees"])["totalFees"]), "cash": held["cash"], "availableSell": sellable, "status": "pending", "worldVersion": state["worldVersion"], "estimated": true}, nil
}
