package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
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

	for _, route := range []string{"/", "/rooms/example"} {
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

func TestWebKeepsUnknownAPIRoutesAsJSONNotFound(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/missing", nil)
	response := httptest.NewRecorder()
	web := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>TTSync</title>")},
	}

	New(Config{
		Ready: func(context.Context) error { return nil },
		Web:   web,
	}).ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	if body := response.Body.String(); body != "{\"error\":\"not_found\"}\n" {
		t.Fatalf("body = %q, want JSON not-found response", body)
	}
}
