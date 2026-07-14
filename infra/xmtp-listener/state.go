package main

import (
	"sync"
	"time"
)

const (
	errorControlUnavailable  = "control_unavailable"
	errorControlStale        = "control_stale"
	errorStreamDisconnected  = "stream_disconnected"
	errorStreamStale         = "stream_stale"
	errorDeliveryUnavailable = "delivery_unavailable"
	errorDeliveryAuthFailed  = "delivery_auth_failed"
	errorDeliveryStale       = "delivery_stale"
)

type runtimeState struct {
	mu                  sync.RWMutex
	streamConnected     bool
	streamConnectedAt   time.Time
	lastEnvelopeAt      time.Time
	lastControlSyncAt   time.Time
	lastControlError    string
	lastDeliveryProbeAt time.Time
	lastDeliveryError   string
}

type runtimeView struct {
	StreamConnected     bool
	StreamConnectedAt   time.Time
	LastEnvelopeAt      time.Time
	LastControlSyncAt   time.Time
	LastControlError    string
	LastDeliveryProbeAt time.Time
	LastDeliveryError   string
}

func newRuntimeState() *runtimeState {
	return &runtimeState{}
}

func (s *runtimeState) markStreamConnected(at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.streamConnected = true
	s.streamConnectedAt = at
	s.lastEnvelopeAt = time.Time{}
}

func (s *runtimeState) markStreamDisconnected() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.streamConnected = false
}

func (s *runtimeState) markEnvelope(at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastEnvelopeAt = at
}

func (s *runtimeState) markControlSync(at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastControlSyncAt = at
	s.lastControlError = ""
}

func (s *runtimeState) markControlError(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastControlError = code
}

func (s *runtimeState) markDeliveryReady(at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastDeliveryProbeAt = at
	s.lastDeliveryError = ""
}

func (s *runtimeState) markDeliveryError(at time.Time, code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastDeliveryProbeAt = at
	s.lastDeliveryError = code
}

func (s *runtimeState) view() runtimeView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return runtimeView{
		StreamConnected:     s.streamConnected,
		StreamConnectedAt:   s.streamConnectedAt,
		LastEnvelopeAt:      s.lastEnvelopeAt,
		LastControlSyncAt:   s.lastControlSyncAt,
		LastControlError:    s.lastControlError,
		LastDeliveryProbeAt: s.lastDeliveryProbeAt,
		LastDeliveryError:   s.lastDeliveryError,
	}
}

func healthStatus(
	now time.Time,
	controlMaxStaleness time.Duration,
	streamStartupGrace time.Duration,
	streamMaxIdle time.Duration,
	deliveryMaxStaleness time.Duration,
	state runtimeView,
	index *indexSnapshot,
) (bool, string) {
	if index == nil || state.LastControlSyncAt.IsZero() {
		return false, errorControlUnavailable
	}
	if now.Sub(state.LastControlSyncAt) > controlMaxStaleness {
		return false, errorControlStale
	}
	if ready, code := deliveryPathStatus(now, deliveryMaxStaleness, state); !ready {
		return false, code
	}
	if !state.StreamConnected {
		return false, errorStreamDisconnected
	}
	if state.LastEnvelopeAt.IsZero() {
		if now.Sub(state.StreamConnectedAt) > streamStartupGrace {
			return false, errorStreamStale
		}
	} else if now.Sub(state.LastEnvelopeAt) > streamMaxIdle {
		return false, errorStreamStale
	}
	return true, ""
}

func deliveryPathStatus(now time.Time, maxStaleness time.Duration, state runtimeView) (bool, string) {
	if state.LastDeliveryError != "" {
		return false, state.LastDeliveryError
	}
	if state.LastDeliveryProbeAt.IsZero() {
		return false, errorDeliveryUnavailable
	}
	if now.Sub(state.LastDeliveryProbeAt) > maxStaleness {
		return false, errorDeliveryStale
	}
	return true, ""
}

func buildStatus(now time.Time, cfg config, state runtimeView, index *indexSnapshot) listenerStatus {
	deliveryReady, _ := deliveryPathStatus(now, cfg.DeliveryProbeMaxStaleness, state)
	ready, errorCode := healthStatus(
		now,
		cfg.ControlMaxStaleness,
		cfg.StreamStartupGrace,
		cfg.StreamMaxIdle,
		cfg.DeliveryProbeMaxStaleness,
		state,
		index,
	)
	status := listenerStatus{
		Version:             1,
		InstanceID:          cfg.InstanceID,
		Ready:               ready,
		ObservedAt:          now.UTC().Format(time.RFC3339Nano),
		ErrorCode:           errorCode,
		StreamConnectedAt:   formatOptionalTime(state.StreamConnectedAt),
		LastEnvelopeAt:      formatOptionalTime(state.LastEnvelopeAt),
		LastControlSyncAt:   formatOptionalTime(state.LastControlSyncAt),
		DeliveryReady:       deliveryReady,
		LastDeliveryProbeAt: formatOptionalTime(state.LastDeliveryProbeAt),
	}
	if index != nil {
		status.Cursor = index.Cursor
		status.RegistrationCount = index.RegistrationCount
		status.TopicCount = index.TopicCount
	}
	return status
}
