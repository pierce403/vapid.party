package main

import (
	"testing"
	"time"
)

func TestHealthStatusTracksControlAndStreamFreshness(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_000, 0)
	index := &indexSnapshot{Cursor: "1"}
	base := runtimeView{
		StreamConnected:     true,
		StreamConnectedAt:   now.Add(-10 * time.Second),
		LastControlSyncAt:   now.Add(-10 * time.Second),
		LastDeliveryProbeAt: now.Add(-10 * time.Second),
	}

	if ready, code := healthStatus(now, time.Minute, 30*time.Second, time.Minute, time.Minute, base, index); !ready || code != "" {
		t.Fatalf("startup grace = %v/%q; want ready", ready, code)
	}
	staleStream := base
	staleStream.StreamConnectedAt = now.Add(-31 * time.Second)
	if ready, code := healthStatus(now, time.Minute, 30*time.Second, time.Minute, time.Minute, staleStream, index); ready || code != errorStreamStale {
		t.Fatalf("stale stream = %v/%q; want %q", ready, code, errorStreamStale)
	}
	staleControl := base
	staleControl.LastControlSyncAt = now.Add(-61 * time.Second)
	if ready, code := healthStatus(now, time.Minute, 30*time.Second, time.Minute, time.Minute, staleControl, index); ready || code != errorControlStale {
		t.Fatalf("stale control = %v/%q; want %q", ready, code, errorControlStale)
	}
}

func TestHealthStatusRequiresFreshAuthenticatedDeliveryPath(t *testing.T) {
	t.Parallel()

	now := time.Unix(2_000, 0)
	index := &indexSnapshot{Cursor: "1"}
	base := runtimeView{
		StreamConnected:   true,
		StreamConnectedAt: now.Add(-10 * time.Second),
		LastControlSyncAt: now.Add(-10 * time.Second),
	}

	if ready, code := healthStatus(now, time.Minute, time.Minute, time.Minute, time.Minute, base, index); ready || code != errorDeliveryUnavailable {
		t.Fatalf("missing delivery probe = %v/%q; want %q", ready, code, errorDeliveryUnavailable)
	}
	authFailed := base
	authFailed.LastDeliveryProbeAt = now
	authFailed.LastDeliveryError = errorDeliveryAuthFailed
	if ready, code := healthStatus(now, time.Minute, time.Minute, time.Minute, time.Minute, authFailed, index); ready || code != errorDeliveryAuthFailed {
		t.Fatalf("delivery auth failure = %v/%q; want %q", ready, code, errorDeliveryAuthFailed)
	}
	stale := base
	stale.LastDeliveryProbeAt = now.Add(-61 * time.Second)
	if ready, code := healthStatus(now, time.Minute, time.Minute, time.Minute, time.Minute, stale, index); ready || code != errorDeliveryStale {
		t.Fatalf("stale delivery probe = %v/%q; want %q", ready, code, errorDeliveryStale)
	}
}

func TestReconnectResetsLastEnvelopeFreshness(t *testing.T) {
	t.Parallel()

	state := newRuntimeState()
	state.markEnvelope(time.Unix(100, 0))
	state.markStreamConnected(time.Unix(200, 0))
	view := state.view()
	if !view.LastEnvelopeAt.IsZero() {
		t.Fatalf("LastEnvelopeAt = %v after reconnect; want zero", view.LastEnvelopeAt)
	}
	if !view.StreamConnected || !view.StreamConnectedAt.Equal(time.Unix(200, 0)) {
		t.Fatalf("stream state after reconnect = %#v", view)
	}
}
