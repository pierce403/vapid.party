package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestInternalClientsRejectRedirectsBeforeBearerForwarding(t *testing.T) {
	t.Parallel()

	var redirectedRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		redirectedRequests.Add(1)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", target.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	control := newControlClient(config{
		ControlPlaneBaseURL: redirector.URL,
		SyncToken:           "sync-secret",
		SnapshotPageSize:    1,
		DeltaPageSize:       1,
		HTTPTimeout:         time.Second,
	})
	if _, _, err := control.FetchSnapshot(context.Background()); err == nil {
		t.Fatal("FetchSnapshot() followed or accepted a redirect")
	}

	delivery := newDeliveryClient(config{
		DeliveryURL:      redirector.URL,
		IngestToken:      "ingest-secret",
		DeliveryAttempts: 1,
		HTTPTimeout:      time.Second,
	})
	if err := delivery.Deliver(context.Background(), deliveryEvent{Version: 1}); err == nil {
		t.Fatal("Deliver() followed or accepted a redirect")
	}

	if got := redirectedRequests.Load(); got != 0 {
		t.Fatalf("redirect target received %d bearer-bearing requests; want 0", got)
	}
}
