package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gofromzero/ttsync/internal/app"
)

func main() {
	config, err := applicationConfigFromEnvironment()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, config); err != nil {
		log.Fatal(err)
	}
}

func applicationConfigFromEnvironment() (app.Config, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if strings.TrimSpace(databaseURL) == "" {
		return app.Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	httpAddr := os.Getenv("HTTP_ADDR")
	if httpAddr == "" {
		httpAddr = ":8080"
	}
	return app.Config{
		DatabaseURL: databaseURL,
		HTTPAddr:    httpAddr,
	}, nil
}
