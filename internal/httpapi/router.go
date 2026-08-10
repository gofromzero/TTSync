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
		filePath := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
		if _, err := fs.Stat(config.Web, filePath); err != nil {
			request = request.Clone(request.Context())
			request.URL.Path = "/"
		}
		http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
	})
	return router
}
