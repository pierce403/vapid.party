package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

type healthResponse struct {
	Version             int    `json:"version"`
	Ready               bool   `json:"ready"`
	ErrorCode           string `json:"errorCode,omitempty"`
	Cursor              string `json:"cursor,omitempty"`
	LastEnvelopeAt      string `json:"lastEnvelopeAt,omitempty"`
	LastControlSyncAt   string `json:"lastControlSyncAt,omitempty"`
	LastDeliveryProbeAt string `json:"lastDeliveryProbeAt,omitempty"`
	RegistrationCount   int    `json:"registrationCount"`
	TopicCount          int    `json:"topicCount"`
}

func runHealthServer(
	ctx context.Context,
	cfg config,
	index *indexManager,
	state *runtimeState,
	logger *slog.Logger,
) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, map[string]any{"version": 1, "live": true})
	})
	mux.HandleFunc("GET /readyz", func(response http.ResponseWriter, _ *http.Request) {
		status := buildStatus(time.Now().UTC(), cfg, state.view(), index.Current())
		code := http.StatusOK
		if !status.Ready {
			code = http.StatusServiceUnavailable
		}
		writeJSON(response, code, healthResponse{
			Version:             1,
			Ready:               status.Ready,
			ErrorCode:           status.ErrorCode,
			Cursor:              status.Cursor,
			LastEnvelopeAt:      status.LastEnvelopeAt,
			LastControlSyncAt:   status.LastControlSyncAt,
			LastDeliveryProbeAt: status.LastDeliveryProbeAt,
			RegistrationCount:   status.RegistrationCount,
			TopicCount:          status.TopicCount,
		})
	})

	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	shutdownComplete := make(chan struct{})
	go func() {
		defer close(shutdownComplete)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("health server shutdown failed", "error", err)
		}
	}()

	logger.Info("health server listening", "address", cfg.ListenAddress)
	err := server.ListenAndServe()
	if !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-shutdownComplete
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
