package main

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

func runDeliveryProbeLoop(
	ctx context.Context,
	cfg config,
	client *deliveryClient,
	state *runtimeState,
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		probeCtx, cancel := context.WithTimeout(ctx, cfg.HTTPTimeout)
		err := client.ProbeReadiness(probeCtx)
		cancel()
		checkedAt := time.Now().UTC()
		if err == nil {
			state.markDeliveryReady(checkedAt)
		} else {
			code := errorDeliveryUnavailable
			var readinessError *deliveryReadinessError
			if errors.As(err, &readinessError) {
				code = readinessError.Code
			}
			state.markDeliveryError(checkedAt, code)
			if ctx.Err() == nil {
				logger.Warn("delivery ingest readiness probe failed", "error", err)
			}
		}

		if !sleepWithContext(ctx, cfg.DeliveryProbeInterval) {
			return
		}
	}
}
