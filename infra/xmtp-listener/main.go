package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	index := newIndexManager()
	state := newRuntimeState()
	control := newControlClient(cfg)
	delivery := newDeliveryClient(cfg)
	listener := newXMTPListener(cfg, index, state, delivery, logger)

	logger.Info(
		"starting XMTP listener",
		"instance_id", cfg.InstanceID,
		"xmtp_address", cfg.XMTPAddress,
		"upstream_commit", pinnedUpstreamCommit,
	)
	go runControlLoop(ctx, cfg, control, index, state, logger)
	go runDeliveryProbeLoop(ctx, cfg, delivery, state, logger)
	go runStatusLoop(ctx, cfg, control, index, state, logger)
	go listener.Run(ctx)

	if err := runHealthServer(ctx, cfg, index, state, logger); err != nil {
		logger.Error("health server stopped unexpectedly", "error", err)
		stop()
		os.Exit(1)
	}
	logger.Info("XMTP listener stopped")
}
