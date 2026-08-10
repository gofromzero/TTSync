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

func TestSPAFallsBackToIndex(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/rooms/example", nil)
	response := httptest.NewRecorder()
	web := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("TTSync shell")},
	}

	New(Config{
		Ready: func(context.Context) error { return nil },
		Web:   web,
	}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if body := response.Body.String(); body != "TTSync shell" {
		t.Fatalf("body = %q, want SPA index", body)
	}
}
