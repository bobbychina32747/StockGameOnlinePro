package game

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db   *sql.DB
	seal cipher.AEAD
}

func openStore(path string) (*Store, error) {
	var key []byte
	var err error
	if path == ":memory:" {
		key = make([]byte, 32)
		_, err = rand.Read(key)
	} else {
		key, err = readKey(path)
	}
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS formal_commands (owner TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,key));
CREATE TABLE IF NOT EXISTS remembered_roles (digest TEXT PRIMARY KEY,sealed TEXT NOT NULL,expires INTEGER NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, seal: seal}, nil
}
func readKey(path string) ([]byte, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	keyPath := path + ".session-key"
	file, err = os.OpenFile(keyPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err == nil {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err == nil {
			_, err = file.Write(key)
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	key, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errorf(500, "Invalid role session encryption key")
	}
	return key, nil
}
func digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (store *Store) saveSession(token string, value *Session) error {
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	nonce := make([]byte, store.seal.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	hash := digest(token)
	encrypted := store.seal.Seal(nil, nonce, plain, []byte(hash))
	split := len(encrypted) - store.seal.Overhead()
	// Match Node RoleSessions' iv | authTag | ciphertext layout and digest AAD.
	packed := append(append(nonce, encrypted[split:]...), encrypted[:split]...)
	_, err = store.db.Exec("INSERT OR REPLACE INTO remembered_roles VALUES (?,?,?)", hash, base64.StdEncoding.EncodeToString(packed), value.Expires)
	return err
}
func (store *Store) loadSession(token string) (*Session, error) {
	var sealed string
	var expires int64
	err := store.db.QueryRow("SELECT sealed,expires FROM remembered_roles WHERE digest=?", digest(token)).Scan(&sealed, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	packed, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil || len(packed) < 28 || expires <= time.Now().UnixMilli() {
		return nil, store.removeSession(token)
	}
	encrypted := append(append([]byte{}, packed[28:]...), packed[12:28]...)
	plain, err := store.seal.Open(nil, packed[:12], encrypted, []byte(digest(token)))
	if err != nil {
		return nil, store.removeSession(token)
	}
	var value Session
	if err = json.Unmarshal(plain, &value); err != nil {
		return nil, store.removeSession(token)
	}
	if value.Expires != expires || !validMarket(value.Principal.Market) {
		return nil, store.removeSession(token)
	}
	return &value, nil
}
func (store *Store) removeSession(token string) error {
	_, err := store.db.Exec("DELETE FROM remembered_roles WHERE digest=?", digest(token))
	return err
}
