package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type deliveryEvent struct {
	Version        int    `json:"version"`
	IdempotencyKey string `json:"idempotencyKey"`
	InstallationID string `json:"installationId"`
	DeliveryToken  string `json:"deliveryToken"`
	Topic          string `json:"topic"`
	MessageType    string `json:"messageType"`
	ShouldPush     bool   `json:"shouldPush"`
	IsSilent       bool   `json:"isSilent"`
}

type deliveryClient struct {
	url         string
	token       string
	maxAttempts int
	httpClient  *http.Client
}

func newDeliveryClient(cfg config) *deliveryClient {
	return &deliveryClient{
		url:         cfg.DeliveryURL,
		token:       cfg.IngestToken,
		maxAttempts: cfg.DeliveryAttempts,
		httpClient:  &http.Client{Timeout: cfg.HTTPTimeout},
	}
}

func (c *deliveryClient) Deliver(ctx context.Context, event deliveryEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}

	var lastError error
	for attempt := 0; attempt < c.maxAttempts; attempt++ {
		retry, err := c.deliverOnce(ctx, body)
		if err == nil {
			return nil
		}
		lastError = err
		if !retry || attempt == c.maxAttempts-1 {
			return lastError
		}
		delay := 250 * time.Millisecond * time.Duration(1<<attempt)
		if delay > 4*time.Second {
			delay = 4 * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return lastError
}

type deliveryReadinessError struct {
	StatusCode int
	Code       string
}

func (e *deliveryReadinessError) Error() string {
	if e.StatusCode == 0 {
		return "delivery ingest readiness probe failed"
	}
	return fmt.Sprintf("delivery ingest readiness probe returned HTTP %d", e.StatusCode)
}

func (c *deliveryClient) ProbeReadiness(ctx context.Context) error {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		strings.TrimRight(c.url, "/")+"/ready",
		nil,
	)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))

	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	code := errorDeliveryUnavailable
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		code = errorDeliveryAuthFailed
	}
	return &deliveryReadinessError{StatusCode: response.StatusCode, Code: code}
}

func (c *deliveryClient) deliverOnce(ctx context.Context, body []byte) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, err
		}
		return true, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return false, nil
	}
	err = fmt.Errorf("delivery ingest returned HTTP %d", response.StatusCode)
	return response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500, err
}
