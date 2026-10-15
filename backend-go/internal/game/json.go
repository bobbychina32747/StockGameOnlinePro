package game

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

type object = map[string]any

func obj(value any) object {
	result, _ := value.(map[string]any)
	if result == nil {
		return object{}
	}
	return result
}
func list(value any) []any {
	result, _ := value.([]any)
	if result == nil {
		return []any{}
	}
	return result
}
func str(value any) string { result, _ := value.(string); return result }
func num(value any) float64 {
	switch value := value.(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case json.Number:
		result, _ := value.Float64()
		return result
	case string:
		result, _ := strconv.ParseFloat(value, 64)
		return result
	}
	return 0
}
func truth(value any) bool { result, _ := value.(bool); return result }
func fallback(value, other any) any {
	if value == nil {
		return other
	}
	return value
}
func nonzero(value, other float64) float64 {
	if value == 0 {
		return other
	}
	return value
}
func cents(value any) int64 { return int64(math.Floor(num(value)*100 + .5)) }
func timestamp(value any) int64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999", "2006-01-02"} {
		if parsed, err := time.Parse(layout, str(value)); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}
func numberString(value any) string { return strconv.FormatFloat(num(value), 'f', -1, 64) }
func canonical(value []byte) (string, error) {
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(decoded)
	return string(encoded), err
}
func errorf(status int, message string, args ...any) error {
	return &APIError{Status: status, Message: fmt.Sprintf(message, args...)}
}

type APIError struct {
	Status  int
	Message string
}

func (err *APIError) Error() string { return err.Message }
