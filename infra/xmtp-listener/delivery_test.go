package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeliveryReadinessProbeAuthenticatesWithoutContent(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("method = %s; want GET", request.Method)
		}
		if request.URL.Path != "/api/internal/xmtp/deliveries/ready" {
			t.Errorf("path = %s; want readiness path", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer ingest-secret" {
			t.Errorf("Authorization = %q; want ingest bearer token", got)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		if len(body) != 0 {
			t.Errorf("request body length = %d; want 0", len(body))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := &deliveryClient{
		url:        server.URL + "/api/internal/xmtp/deliveries",
		token:      "ingest-secret",
		httpClient: server.Client(),
	}
	if err := client.ProbeReadiness(context.Background()); err != nil {
		t.Fatalf("ProbeReadiness() error = %v", err)
	}
}

func TestDeliveryReadinessProbeClassifiesAuthFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	client := &deliveryClient{
		url:        server.URL + "/api/internal/xmtp/deliveries",
		token:      "stale-secret",
		httpClient: server.Client(),
	}
	err := client.ProbeReadiness(context.Background())
	var readinessError *deliveryReadinessError
	if !errors.As(err, &readinessError) {
		t.Fatalf("ProbeReadiness() error = %v; want deliveryReadinessError", err)
	}
	if readinessError.Code != errorDeliveryAuthFailed {
		t.Fatalf("readiness error code = %q; want %q", readinessError.Code, errorDeliveryAuthFailed)
	}
}
