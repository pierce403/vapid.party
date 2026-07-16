package main

import (
	"context"
	"log/slog"
	"time"
)

func runControlLoop(
	ctx context.Context,
	cfg config,
	client *controlClient,
	index *indexManager,
	state *runtimeState,
	logger *slog.Logger,
) {
	loaded := false
	backoff := time.Second

	for ctx.Err() == nil {
		var err error
		if !loaded {
			err = loadFullSnapshot(ctx, client, index)
			if err == nil {
				loaded = true
			}
		} else {
			err = applyCurrentDeltas(ctx, client, index)
			if shouldReloadSnapshot(err) {
				logger.Warn("control state requires a fresh full snapshot", "error", err)
				loaded = false
				continue
			}
		}

		if err != nil {
			state.markControlError(errorControlUnavailable)
			logger.Error("registration control sync failed", "error", err)
			if !sleepWithContext(ctx, backoff) {
				return
			}
			backoff = nextControlBackoff(backoff)
			continue
		}

		now := time.Now().UTC()
		state.markControlSync(now)
		backoff = time.Second
		if !sleepWithContext(ctx, cfg.ControlPollInterval) {
			return
		}
	}
}

func loadFullSnapshot(ctx context.Context, client *controlClient, index *indexManager) error {
	cursor, registrations, err := client.FetchSnapshot(ctx)
	if err != nil {
		return err
	}
	if err := index.Replace(cursor, registrations, time.Now().UTC()); err != nil {
		return err
	}
	return applyCurrentDeltas(ctx, client, index)
}

func applyCurrentDeltas(ctx context.Context, client *controlClient, index *indexManager) error {
	current := index.Current()
	if current == nil {
		return nil
	}
	cursor, changes, err := client.FetchDeltas(ctx, current.Cursor)
	if err != nil {
		return err
	}
	return index.ApplyDeltas(cursor, changes, time.Now().UTC())
}

func nextControlBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
}

func runStatusLoop(
	ctx context.Context,
	cfg config,
	client *controlClient,
	index *indexManager,
	state *runtimeState,
	logger *slog.Logger,
) {
	ticker := time.NewTicker(cfg.StatusReportInterval)
	defer ticker.Stop()
	for {
		status := buildStatus(time.Now().UTC(), cfg, state.view(), index.Current())
		reportCtx, cancel := context.WithTimeout(ctx, cfg.HTTPTimeout)
		err := client.ReportStatus(reportCtx, status)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Warn("listener status report failed", "error", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
