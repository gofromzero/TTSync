package httpapi

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
)

type Config struct {
	Ready func(context.Context) error
	Web   fs.FS
}

func New(config Config) http.Handler {
	router := chi.NewRouter()
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
		http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
	})
	return router
}
