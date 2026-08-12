package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gofromzero/ttsync/internal/identity"
)

type Config struct {
	Ready              func(context.Context) error
	Web                fs.FS
	PublicOrigin       string
	Register           func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)
	ResendVerification func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)
	VerifyEmail        func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)
}

func New(config Config) http.Handler {
	router := chi.NewRouter()
	newRequestID := func(incoming string) string {
		compact := strings.ReplaceAll(incoming, "-", "")
		if len(incoming) == 36 && len(compact) == 32 {
			if _, err := hex.DecodeString(compact); err == nil && incoming[8] == '-' && incoming[13] == '-' && incoming[18] == '-' && incoming[23] == '-' {
				return incoming
			}
		}
		bytes := make([]byte, 16)
		if _, err := rand.Read(bytes); err != nil {
			return "00000000-0000-4000-8000-000000000000"
		}
		bytes[6] = bytes[6]&0x0f | 0x40
		bytes[8] = bytes[8]&0x3f | 0x80
		return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
	}
	writeProblem := func(writer http.ResponseWriter, request *http.Request, requestID string, status int, code, title, detail string) {
		writer.Header().Set("Content-Type", "application/problem+json")
		writer.Header().Set("X-Request-ID", requestID)
		writer.WriteHeader(status)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"type": "https://ttsync.example/problems/" + strings.ToLower(strings.ReplaceAll(code, "_", "-")), "title": title,
			"status": status, "detail": detail, "instance": request.URL.Path, "code": code, "requestId": requestID,
		})
	}
	writeValidation := func(writer http.ResponseWriter, request *http.Request, requestID, field string) {
		writer.Header().Set("Content-Type", "application/problem+json")
		writer.Header().Set("X-Request-ID", requestID)
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"type": "https://ttsync.example/problems/validation-failed", "title": "输入校验失败", "status": http.StatusUnprocessableEntity,
			"detail": "请求字段无效。", "instance": request.URL.Path, "code": "VALIDATION_FAILED", "requestId": requestID,
			"violations": []map[string]string{{"path": "/" + field, "code": "INVALID_VALUE", "message": "字段值无效。"}},
		})
	}
	mapError := func(writer http.ResponseWriter, request *http.Request, requestID string, err error) {
		switch {
		case errors.Is(err, identity.ErrInvalidEmail):
			writeValidation(writer, request, requestID, "email")
		case errors.Is(err, identity.ErrInvalidPassword):
			writeValidation(writer, request, requestID, "password")
		case errors.Is(err, identity.ErrInvalidToken):
			writeValidation(writer, request, requestID, "token")
		case errors.Is(err, identity.ErrRateLimited):
			writer.Header().Set("Retry-After", "60")
			writeProblem(writer, request, requestID, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁", "请在 Retry-After 指定时间后重试。")
		default:
			writeProblem(writer, request, requestID, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时失败", "请求未能完成，请使用 requestId 联系维护者。")
		}
	}
	decodeJSON := func(writer http.ResponseWriter, request *http.Request, requestID string, destination any) bool {
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			return false
		}
		request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(destination); err != nil {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			return false
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			return false
		}
		return true
	}
	authorize := func(writer http.ResponseWriter, request *http.Request) (string, bool) {
		requestID := newRequestID(request.Header.Get("X-Request-ID"))
		writer.Header().Set("X-Request-ID", requestID)
		cookie, err := request.Cookie("__Host-ttsync-csrf")
		header := request.Header.Get("X-CSRF-Token")
		if request.Header.Get("Origin") != config.PublicOrigin || err != nil || cookie.Value == "" || header == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header)) != 1 {
			writeProblem(writer, request, requestID, http.StatusForbidden, "FORBIDDEN", "请求被拒绝", "Origin 或 CSRF 凭据无效。")
			return requestID, false
		}
		return requestID, true
	}
	requestIP := func(request *http.Request) string {
		ip := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-For"), ",")[0])
		if ip != "" {
			return ip
		}
		if host, _, err := net.SplitHostPort(request.RemoteAddr); err == nil {
			return host
		}
		return request.RemoteAddr
	}
	issueCSRF := func(writer http.ResponseWriter, request *http.Request) bool {
		if _, err := request.Cookie("__Host-ttsync-csrf"); err == nil {
			return true
		}
		bytes := make([]byte, 16)
		if _, err := rand.Read(bytes); err != nil {
			http.Error(writer, "service unavailable", http.StatusInternalServerError)
			return false
		}
		http.SetCookie(writer, &http.Cookie{
			Name:     "__Host-ttsync-csrf",
			Value:    base64.RawURLEncoding.EncodeToString(bytes),
			Path:     "/",
			Secure:   true,
			SameSite: http.SameSiteStrictMode,
		})
		return true
	}
	router.Get("/health/live", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{"status": "live"})
	})
	router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		status := "ready"
		if config.Ready(request.Context()) != nil {
			status = "not_ready"
			writer.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(writer).Encode(map[string]string{"status": status})
	})
	router.Post("/api/v1/accounts", func(writer http.ResponseWriter, request *http.Request) {
		requestID, ok := authorize(writer, request)
		if !ok {
			return
		}
		var body *struct {
			Email, Password, InvitationToken json.RawMessage
		}
		if !decodeJSON(writer, request, requestID, &body) || body == nil {
			if body == nil && writer.Header().Get("Content-Type") != "application/problem+json" {
				writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			}
			return
		}
		if len(body.Email) == 0 {
			writeValidation(writer, request, requestID, "email")
			return
		}
		if len(body.Password) == 0 {
			writeValidation(writer, request, requestID, "password")
			return
		}
		var email, password, invitationToken string
		if body.Email[0] != '"' || body.Password[0] != '"' || len(body.InvitationToken) > 0 && body.InvitationToken[0] != '"' || json.Unmarshal(body.Email, &email) != nil || json.Unmarshal(body.Password, &password) != nil || len(body.InvitationToken) > 0 && json.Unmarshal(body.InvitationToken, &invitationToken) != nil {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求字段类型无效。")
			return
		}
		if invitationToken != "" && (len(invitationToken) < 32 || len(invitationToken) > 512) {
			writeValidation(writer, request, requestID, "invitationToken")
			return
		}
		ip := requestIP(request)
		_, err := config.Register(request.Context(), identity.RegisterCommand{Email: email, Password: password, IP: ip, RequestID: requestID, RequestTime: time.Now()})
		if err != nil {
			mapError(writer, request, requestID, err)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]bool{"accepted": true})
	})
	router.Post("/api/v1/accounts/verification/resend", func(writer http.ResponseWriter, request *http.Request) {
		requestID, ok := authorize(writer, request)
		if !ok {
			return
		}
		var body *struct{ Email json.RawMessage }
		if !decodeJSON(writer, request, requestID, &body) || body == nil {
			if body == nil && writer.Header().Get("Content-Type") != "application/problem+json" {
				writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			}
			return
		}
		if len(body.Email) == 0 {
			writeValidation(writer, request, requestID, "email")
			return
		}
		var email string
		if body.Email[0] != '"' || json.Unmarshal(body.Email, &email) != nil {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求字段类型无效。")
			return
		}
		ip := requestIP(request)
		_, err := config.ResendVerification(request.Context(), identity.ResendVerificationCommand{Email: email, IP: ip, RequestID: requestID, RequestTime: time.Now()})
		if err != nil {
			mapError(writer, request, requestID, err)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]bool{"accepted": true})
	})
	router.Post("/api/v1/accounts/verification", func(writer http.ResponseWriter, request *http.Request) {
		requestID, ok := authorize(writer, request)
		if !ok {
			return
		}
		var body *struct{ Token json.RawMessage }
		if !decodeJSON(writer, request, requestID, &body) || body == nil {
			if body == nil && writer.Header().Get("Content-Type") != "application/problem+json" {
				writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求必须是单个 JSON 对象。")
			}
			return
		}
		if len(body.Token) == 0 {
			writeValidation(writer, request, requestID, "token")
			return
		}
		var token string
		if body.Token[0] != '"' || json.Unmarshal(body.Token, &token) != nil {
			writeProblem(writer, request, requestID, http.StatusBadRequest, "MALFORMED_REQUEST", "请求无法解析", "请求字段类型无效。")
			return
		}
		if len(token) < 32 || len(token) > 512 {
			writeValidation(writer, request, requestID, "token")
			return
		}
		ip := requestIP(request)
		_, err := config.VerifyEmail(request.Context(), identity.VerifyEmailCommand{Token: token, IP: ip, RequestID: requestID, RequestTime: time.Now()})
		if err != nil {
			mapError(writer, request, requestID, err)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]bool{"verified": true})
	})
	router.NotFound(func(writer http.ResponseWriter, request *http.Request) {
		normalizedPath := path.Clean("/" + request.URL.Path)
		if strings.HasPrefix(normalizedPath, "/api/") {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(writer).Encode(map[string]string{"error": "not_found"})
			return
		}
		filePath := strings.TrimPrefix(normalizedPath, "/")
		info, err := fs.Stat(config.Web, filePath)
		if err == nil && info.Mode().IsRegular() {
			if filePath == "index.html" && !issueCSRF(writer, request) {
				return
			}
			request = request.Clone(request.Context())
			request.URL.Path = normalizedPath
			http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
			return
		}
		if err == nil || normalizedPath == "/assets" || strings.HasPrefix(normalizedPath, "/assets/") {
			http.NotFound(writer, request)
			return
		}
		if _, err := fs.Stat(config.Web, "index.html"); err == nil {
			request = request.Clone(request.Context())
			request.URL.Path = "/"
		}
		if request.URL.Path == "/" && !issueCSRF(writer, request) {
			return
		}
		http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
	})
	return router
}
