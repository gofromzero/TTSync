package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gofromzero/ttsync/internal/identity"
)

func TestHealth(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		ready      func(context.Context) error
		wantStatus int
		wantBody   string
	}{
		{
			name: "liveness is always live",
			path: "/health/live",
			ready: func(context.Context) error {
				return errors.New("database unavailable")
			},
			wantStatus: http.StatusOK,
			wantBody:   "{\"status\":\"live\"}\n",
		},
		{
			name:       "readiness is ready when dependency is healthy",
			path:       "/health/ready",
			ready:      func(context.Context) error { return nil },
			wantStatus: http.StatusOK,
			wantBody:   "{\"status\":\"ready\"}\n",
		},
		{
			name: "readiness is unavailable when dependency is unhealthy",
			path: "/health/ready",
			ready: func(context.Context) error {
				return errors.New("database unavailable")
			},
			wantStatus: http.StatusServiceUnavailable,
			wantBody:   "{\"status\":\"not_ready\"}\n",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()

			New(Config{Ready: test.ready}).ServeHTTP(response, request)

			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
				t.Fatalf("Content-Type = %q, want application/json", contentType)
			}
			if body := response.Body.String(); body != test.wantBody {
				t.Fatalf("body = %q, want %q", body, test.wantBody)
			}
		})
	}
}

func TestWebServesIndex(t *testing.T) {
	web := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>TTSync</title>")},
	}
	handler := New(Config{
		Ready: func(context.Context) error { return nil },
		Web:   web,
	})

	for _, route := range []string{
		"/",
		"/rooms/example",
		"/rooms/table.v2",
		"/games/campaign.2026/session",
	} {
		t.Run(route, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, route, nil)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
			}
			if contentType := response.Header().Get("Content-Type"); contentType != "text/html; charset=utf-8" {
				t.Fatalf("Content-Type = %q, want text/html; charset=utf-8", contentType)
			}
			if body := response.Body.String(); body != "<!doctype html><title>TTSync</title>" {
				t.Fatalf("body = %q, want SPA index", body)
			}
		})
	}

}

func TestWebIndexIssuesStableCSRFCookie(t *testing.T) {
	handler := New(Config{
		Ready:        func(context.Context) error { return nil },
		Web:          fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("index")}},
		PublicOrigin: "https://localhost:8443",
	})
	firstRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	firstResponse := httptest.NewRecorder()
	handler.ServeHTTP(firstResponse, firstRequest)

	cookies := firstResponse.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != "__Host-ttsync-csrf" || cookie.Value == "" || !cookie.Secure || cookie.HttpOnly || cookie.Path != "/" || cookie.Domain != "" || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("CSRF cookie = %#v", cookie)
	}

	secondRequest := httptest.NewRequest(http.MethodGet, "/rooms/example", nil)
	secondRequest.AddCookie(cookie)
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, secondRequest)
	if got := secondResponse.Header().Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("existing CSRF cookie rotated: %v", got)
	}
}

func TestIdentityPostsPassCommandsAndReturnOnlyContractFields(t *testing.T) {
	const requestID = "018f5f60-c9c7-77e3-a6bb-08de53542952"
	tests := []struct {
		name, path, body, wantBody string
		configure                  func(*Config, *string)
	}{
		{
			name: "register", path: "/api/v1/accounts", body: `{"email":"User@example.com","password":"a secure passphrase","invitationToken":"ignored-by-id01-0123456789012345"}`, wantBody: "{\"accepted\":true}\n",
			configure: func(config *Config, got *string) {
				config.Register = func(_ context.Context, command identity.RegisterCommand) (identity.AcceptedResult, error) {
					if command.Password != "a secure passphrase" {
						t.Fatalf("Password = %q", command.Password)
					}
					*got = command.Email + "|" + command.IP + "|" + command.RequestID
					if command.RequestTime.IsZero() {
						t.Fatal("RequestTime is zero")
					}
					return identity.AcceptedResult{Accepted: true}, nil
				}
			},
		},
		{
			name: "resend", path: "/api/v1/accounts/verification/resend", body: `{"email":"User@example.com"}`, wantBody: "{\"accepted\":true}\n",
			configure: func(config *Config, got *string) {
				config.ResendVerification = func(_ context.Context, command identity.ResendVerificationCommand) (identity.AcceptedResult, error) {
					*got = command.Email + "|" + command.IP + "|" + command.RequestID
					return identity.AcceptedResult{Accepted: true}, nil
				}
			},
		},
		{
			name: "verify", path: "/api/v1/accounts/verification", body: `{"token":"01234567890123456789012345678901"}`, wantBody: "{\"verified\":true}\n",
			configure: func(config *Config, got *string) {
				config.VerifyEmail = func(_ context.Context, command identity.VerifyEmailCommand) (identity.VerifiedResult, error) {
					*got = command.Token + "|" + command.IP + "|" + command.RequestID
					return identity.VerifiedResult{Verified: true}, nil
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ""
			config := Config{Ready: func(context.Context) error { return nil }, PublicOrigin: "https://localhost:8443"}
			test.configure(&config, &got)
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "https://localhost:8443")
			request.Header.Set("X-CSRF-Token", "csrf-token")
			request.Header.Set("X-Request-ID", requestID)
			request.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.1")
			request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
			response := httptest.NewRecorder()

			New(config).ServeHTTP(response, request)

			if response.Code != http.StatusOK || response.Body.String() != test.wantBody {
				t.Fatalf("response = %d %q", response.Code, response.Body.String())
			}
			if response.Header().Get("X-Request-ID") != requestID || response.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("headers = %#v", response.Header())
			}
			if test.name == "verify" {
				if got != "01234567890123456789012345678901|198.51.100.7|"+requestID {
					t.Fatalf("command = %q", got)
				}
			} else if got != "User@example.com|198.51.100.7|"+requestID {
				t.Fatalf("command = %q", got)
			}
		})
	}
}

func TestIdentityPostsRejectOriginAndCSRFMismatchesBeforeIdentity(t *testing.T) {
	tests := []struct {
		name, origin, header, cookie string
	}{
		{name: "missing origin", header: "csrf-token", cookie: "csrf-token"},
		{name: "shared origin prefix", origin: "https://localhost:8443.evil.test", header: "csrf-token", cookie: "csrf-token"},
		{name: "userinfo origin", origin: "https://localhost:8443@evil.test", header: "csrf-token", cookie: "csrf-token"},
		{name: "missing header", origin: "https://localhost:8443", cookie: "csrf-token"},
		{name: "missing cookie", origin: "https://localhost:8443", header: "csrf-token"},
		{name: "wrong token", origin: "https://localhost:8443", header: "other-token", cookie: "csrf-token"},
		{name: "shared token prefix", origin: "https://localhost:8443", header: "csrf-token-extra", cookie: "csrf-token"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := 0
			handler := New(Config{
				PublicOrigin: "https://localhost:8443",
				Register: func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error) {
					called++
					return identity.AcceptedResult{Accepted: true}, nil
				},
			})
			request := httptest.NewRequest(http.MethodPost, "/api/v1/accounts", strings.NewReader(`{"email":"user@example.com","password":"a secure passphrase"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", test.origin)
			request.Header.Set("X-CSRF-Token", test.header)
			if test.cookie != "" {
				request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: test.cookie})
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusForbidden || response.Header().Get("Content-Type") != "application/problem+json" || !strings.Contains(response.Body.String(), `"code":"FORBIDDEN"`) {
				t.Fatalf("response = %d %#v %q", response.Code, response.Header(), response.Body.String())
			}
			if response.Header().Get("X-Request-ID") == "" {
				t.Fatal("missing generated X-Request-ID")
			}
			if called != 0 {
				t.Fatalf("identity called %d times", called)
			}
		})
	}
}

func TestIdentityPostsRejectMalformedRequestsBeforeIdentity(t *testing.T) {
	tests := []struct{ name, contentType, body string }{
		{name: "missing media type", body: `{"email":"user@example.com","password":"a secure passphrase"}`},
		{name: "wrong media type", contentType: "text/plain", body: `{"email":"user@example.com","password":"a secure passphrase"}`},
		{name: "malformed JSON", contentType: "application/json", body: `{"email":`},
		{name: "wrong JSON type", contentType: "application/json", body: `{"email":1,"password":"a secure passphrase"}`},
		{name: "null field type", contentType: "application/json", body: `{"email":null,"password":"a secure passphrase"}`},
		{name: "unknown field", contentType: "application/json", body: `{"email":"user@example.com","password":"a secure passphrase","admin":true}`},
		{name: "trailing value", contentType: "application/json", body: `{"email":"user@example.com","password":"a secure passphrase"} {}`},
		{name: "null", contentType: "application/json", body: `null`},
		{name: "oversized", contentType: "application/json", body: `{"email":"user@example.com","password":"` + strings.Repeat("x", 70<<10) + `"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := 0
			handler := New(Config{
				PublicOrigin: "https://localhost:8443",
				Register: func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error) {
					called++
					return identity.AcceptedResult{Accepted: true}, nil
				},
			})
			request := httptest.NewRequest(http.MethodPost, "/api/v1/accounts", strings.NewReader(test.body))
			if test.contentType != "" {
				request.Header.Set("Content-Type", test.contentType)
			}
			request.Header.Set("Origin", "https://localhost:8443")
			request.Header.Set("X-CSRF-Token", "csrf-token")
			request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest || response.Header().Get("Content-Type") != "application/problem+json" || !strings.Contains(response.Body.String(), `"code":"MALFORMED_REQUEST"`) {
				t.Fatalf("response = %d %#v %q", response.Code, response.Header(), response.Body.String())
			}
			if called != 0 {
				t.Fatalf("identity called %d times", called)
			}
		})
	}
}

func TestIdentityPostsRejectContractValidationBeforeIdentity(t *testing.T) {
	tests := []struct{ name, path, body string }{
		{name: "register missing email", path: "/api/v1/accounts", body: `{"password":"a secure passphrase"}`},
		{name: "register missing password", path: "/api/v1/accounts", body: `{"email":"user@example.com"}`},
		{name: "register short invitation token", path: "/api/v1/accounts", body: `{"email":"user@example.com","password":"a secure passphrase","invitationToken":"short"}`},
		{name: "resend missing email", path: "/api/v1/accounts/verification/resend", body: `{}`},
		{name: "verify short token", path: "/api/v1/accounts/verification", body: `{"token":"short"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := 0
			config := Config{
				PublicOrigin: "https://localhost:8443",
				Register: func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error) {
					called++
					return identity.AcceptedResult{Accepted: true}, nil
				},
				ResendVerification: func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error) {
					called++
					return identity.AcceptedResult{Accepted: true}, nil
				},
				VerifyEmail: func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error) {
					called++
					return identity.VerifiedResult{Verified: true}, nil
				},
			}
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "https://localhost:8443")
			request.Header.Set("X-CSRF-Token", "csrf-token")
			request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
			response := httptest.NewRecorder()

			New(config).ServeHTTP(response, request)

			if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"code":"VALIDATION_FAILED"`) || !strings.Contains(response.Body.String(), `"violations"`) {
				t.Fatalf("response = %d %q", response.Code, response.Body.String())
			}
			if called != 0 {
				t.Fatalf("identity called %d times", called)
			}
		})
	}
}

func TestIdentityPostsMapDomainRateAndInternalErrors(t *testing.T) {
	secretFailure := errors.New("database password=do-not-leak token=do-not-leak")
	tests := []struct {
		name, path, body string
		err              error
		wantStatus       int
		wantCode         string
		wantRetryAfter   string
	}{
		{name: "invalid email", path: "/api/v1/accounts", body: `{"email":"bad","password":"a secure passphrase"}`, err: identity.ErrInvalidEmail, wantStatus: 422, wantCode: "VALIDATION_FAILED"},
		{name: "invalid password", path: "/api/v1/accounts", body: `{"email":"user@example.com","password":"a secure passphrase"}`, err: identity.ErrInvalidPassword, wantStatus: 422, wantCode: "VALIDATION_FAILED"},
		{name: "invalid token", path: "/api/v1/accounts/verification", body: `{"token":"01234567890123456789012345678901"}`, err: identity.ErrInvalidToken, wantStatus: 422, wantCode: "VALIDATION_FAILED"},
		{name: "register rate limited", path: "/api/v1/accounts", body: `{"email":"user@example.com","password":"a secure passphrase"}`, err: identity.ErrRateLimited, wantStatus: 429, wantCode: "RATE_LIMITED", wantRetryAfter: "60"},
		{name: "resend rate limited", path: "/api/v1/accounts/verification/resend", body: `{"email":"user@example.com"}`, err: identity.ErrRateLimited, wantStatus: 429, wantCode: "RATE_LIMITED", wantRetryAfter: "60"},
		{name: "verify rate limited", path: "/api/v1/accounts/verification", body: `{"token":"01234567890123456789012345678901"}`, err: identity.ErrRateLimited, wantStatus: 429, wantCode: "RATE_LIMITED", wantRetryAfter: "60"},
		{name: "internal error", path: "/api/v1/accounts", body: `{"email":"user@example.com","password":"a secure passphrase"}`, err: secretFailure, wantStatus: 500, wantCode: "INTERNAL_ERROR"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := Config{PublicOrigin: "https://localhost:8443"}
			config.Register = func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error) {
				return identity.AcceptedResult{}, test.err
			}
			config.ResendVerification = func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error) {
				return identity.AcceptedResult{}, test.err
			}
			config.VerifyEmail = func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error) {
				return identity.VerifiedResult{}, test.err
			}
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "https://localhost:8443")
			request.Header.Set("X-CSRF-Token", "csrf-token")
			request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
			response := httptest.NewRecorder()

			New(config).ServeHTTP(response, request)

			if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), `"code":"`+test.wantCode+`"`) || response.Header().Get("Retry-After") != test.wantRetryAfter {
				t.Fatalf("response = %d %#v %q", response.Code, response.Header(), response.Body.String())
			}
			if strings.Contains(response.Body.String(), "do-not-leak") || strings.Contains(response.Body.String(), identity.ErrInvalidToken.Error()) {
				t.Fatalf("response leaked internal error: %q", response.Body.String())
			}
		})
	}
}

func TestInvalidTokenResponsesAreIndistinguishable(t *testing.T) {
	requestBody := `{"token":"01234567890123456789012345678901"}`
	responses := make([]string, 0, 2)
	for _, returned := range []error{identity.ErrInvalidToken, fmt.Errorf("expired generation detail: %w", identity.ErrInvalidToken)} {
		config := Config{
			PublicOrigin: "https://localhost:8443",
			VerifyEmail: func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error) {
				return identity.VerifiedResult{}, returned
			},
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/accounts/verification", strings.NewReader(requestBody))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "https://localhost:8443")
		request.Header.Set("X-CSRF-Token", "csrf-token")
		request.Header.Set("X-Request-ID", "018f5f60-c9c7-77e3-a6bb-08de53542952")
		request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
		response := httptest.NewRecorder()
		New(config).ServeHTTP(response, request)
		responses = append(responses, response.Body.String())
	}
	if responses[0] != responses[1] || strings.Contains(responses[1], "expired") || strings.Contains(responses[1], "generation") {
		t.Fatalf("token responses differ or leak detail:\n%s\n%s", responses[0], responses[1])
	}
}

func TestIdentityPostUsesRemoteHostWithoutPortWhenForwardedForIsAbsent(t *testing.T) {
	gotIP := ""
	config := Config{
		PublicOrigin: "https://localhost:8443",
		ResendVerification: func(_ context.Context, command identity.ResendVerificationCommand) (identity.AcceptedResult, error) {
			gotIP = command.IP
			return identity.AcceptedResult{Accepted: true}, nil
		},
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/accounts/verification/resend", strings.NewReader(`{"email":"user@example.com"}`))
	request.RemoteAddr = "198.51.100.9:54321"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://localhost:8443")
	request.Header.Set("X-CSRF-Token", "csrf-token")
	request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
	response := httptest.NewRecorder()

	New(config).ServeHTTP(response, request)

	if response.Code != http.StatusOK || gotIP != "198.51.100.9" {
		t.Fatalf("response = %d, IP = %q", response.Code, gotIP)
	}
}

func TestWebKeepsUnknownAPIRoutesAsJSONNotFound(t *testing.T) {
	web := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>TTSync</title>")},
	}
	handler := New(Config{
		Ready: func(context.Context) error { return nil },
		Web:   web,
	})

	tests := []struct {
		name string
		path string
	}{
		{name: "canonical API path", path: "/api/missing"},
		{name: "repeated leading slash", path: "//api/missing"},
		{name: "parent segment", path: "/../api/missing"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.URL.Path = test.path
			request.RequestURI = test.path
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
			}
			if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
				t.Fatalf("Content-Type = %q, want application/json", contentType)
			}
			if body := response.Body.String(); body != "{\"error\":\"not_found\"}\n" {
				t.Fatalf("body = %q, want JSON not-found response", body)
			}
		})
	}
}

func TestWebRejectsDirectoriesAndMissingAssets(t *testing.T) {
	web := fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<!doctype html><title>TTSync</title>")},
		"assets":             &fstest.MapFile{Mode: fs.ModeDir},
		"assets/existing.js": &fstest.MapFile{Data: []byte("console.log('TTSync')")},
	}
	handler := New(Config{
		Ready: func(context.Context) error { return nil },
		Web:   web,
	})

	tests := []struct {
		name string
		path string
	}{
		{name: "embedded directory", path: "/assets"},
		{name: "embedded directory with slash", path: "/assets/"},
		{name: "missing bundled asset", path: "/assets/missing.js"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
			}
			if body := response.Body.String(); body == "<!doctype html><title>TTSync</title>" {
				t.Fatal("asset miss returned SPA index")
			}
			if body := response.Body.String(); strings.Contains(body, "existing.js") {
				t.Fatalf("directory response leaked asset listing: %q", body)
			}
		})
	}
}
