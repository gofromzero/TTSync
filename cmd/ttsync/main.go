package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/gofromzero/ttsync/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	httpAddr := os.Getenv("HTTP_ADDR")
	if httpAddr == "" {
		httpAddr = ":8080"
	}

	if err := app.Run(ctx, app.Config{
		DatabaseURL: os.Getenv("DATABASE_URL"),
		HTTPAddr:    httpAddr,
	}); err != nil {
		log.Fatal(err)
	}
}
