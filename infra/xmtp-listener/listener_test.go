package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	messageAPI "github.com/xmtp/xmtpd/pkg/proto/message_api/v1"
	mlsV1 "github.com/xmtp/xmtpd/pkg/proto/mls/api/v1"
	"google.golang.org/protobuf/proto"
)

func TestProcessEnvelopeSuppressesSenderPerAppRoute(t *testing.T) {
	t.Parallel()

	var (
		mu     sync.Mutex
		events []deliveryEvent
	)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer ingest-secret" {
			t.Errorf("Authorization = %q; want bearer token", got)
		}
		var event deliveryEvent
		if err := json.NewDecoder(request.Body).Decode(&event); err != nil {
			t.Errorf("decode delivery: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	keyA := []byte("sender-is-app-a")
	keyB := []byte("sender-is-not-app-b")
	index := newIndexManager()
	if err := index.Replace("1", []registration{
		testRegistration("converge", "token-a", keyA),
		testRegistration("farcaster-miniapp", "token-b", keyB),
	}, time.Now()); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	state := newRuntimeState()
	state.markControlSync(time.Now())
	state.markDeliveryReady(time.Now())
	delivery := &deliveryClient{
		url:         server.URL,
		token:       "ingest-secret",
		maxAttempts: 1,
		httpClient:  server.Client(),
	}
	listener := newXMTPListener(
		config{
			ControlMaxStaleness:       time.Minute,
			StreamStartupGrace:        time.Minute,
			StreamMaxIdle:             time.Minute,
			DeliveryProbeMaxStaleness: time.Minute,
		},
		index,
		state,
		delivery,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)

	data := []byte("opaque MLS ciphertext")
	mac := hmac.New(sha256.New, keyA)
	_, _ = mac.Write(data)
	envelope := testGroupEnvelope(t, data, mac.Sum(nil), true)
	listener.processEnvelope(context.Background(), envelope)

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 {
		t.Fatalf("delivered %d events; want 1", len(events))
	}
	event := events[0]
	if event.DeliveryToken != "token-b" || event.InstallationID != testInstallationID {
		t.Fatalf("event route = %q/%q; want token-b/%s", event.DeliveryToken, event.InstallationID, testInstallationID)
	}
	if event.Topic != testGroupTopic || event.MessageType != messageTypeConversation {
		t.Fatalf("event topic/type = %q/%q", event.Topic, event.MessageType)
	}
	if !event.ShouldPush {
		t.Fatal("event shouldPush is not true")
	}

	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range [][]byte{data, envelope.Message} {
		if stringContainsBytes(encoded, forbidden) {
			t.Fatalf("minimal delivery leaked message bytes: %s", encoded)
		}
	}
}

func TestProcessEnvelopeHonorsShouldPushFalse(t *testing.T) {
	t.Parallel()

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	index := newIndexManager()
	if err := index.Replace("1", []registration{
		testRegistration("converge", "token-a", []byte("key-a")),
	}, time.Now()); err != nil {
		t.Fatal(err)
	}
	state := newRuntimeState()
	state.markControlSync(time.Now())
	state.markDeliveryReady(time.Now())
	listener := newXMTPListener(
		config{
			ControlMaxStaleness:       time.Minute,
			StreamStartupGrace:        time.Minute,
			StreamMaxIdle:             time.Minute,
			DeliveryProbeMaxStaleness: time.Minute,
		},
		index,
		state,
		&deliveryClient{url: server.URL, token: "secret", maxAttempts: 1, httpClient: server.Client()},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	listener.processEnvelope(context.Background(), testGroupEnvelope(t, []byte("data"), nil, false))
	if requests != 0 {
		t.Fatalf("delivery requests = %d; want 0", requests)
	}
}

func TestProcessEnvelopeFailureLogOmitsRouteMetadata(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	index := newIndexManager()
	if err := index.Replace("1", []registration{
		testRegistration("converge", "token-a", []byte("key-a")),
	}, time.Now()); err != nil {
		t.Fatal(err)
	}
	state := newRuntimeState()
	state.markControlSync(time.Now())
	state.markDeliveryReady(time.Now())
	var logs bytes.Buffer
	listener := newXMTPListener(
		config{
			ControlMaxStaleness:       time.Minute,
			StreamStartupGrace:        time.Minute,
			StreamMaxIdle:             time.Minute,
			DeliveryProbeMaxStaleness: time.Minute,
		},
		index,
		state,
		&deliveryClient{url: server.URL, token: "secret", maxAttempts: 1, httpClient: server.Client()},
		slog.New(slog.NewTextHandler(&logs, nil)),
	)

	listener.processEnvelope(context.Background(), testGroupEnvelope(t, []byte("data"), nil, true))
	output := logs.String()
	if !strings.Contains(output, "delivery ingest failed") {
		t.Fatalf("missing coarse delivery failure log: %s", output)
	}
	for _, forbidden := range []string{testInstallationID, testGroupTopic, "installation_id", "topic"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("delivery failure log leaked route metadata %q: %s", forbidden, output)
		}
	}
}

func testGroupEnvelope(t *testing.T, data, senderHMAC []byte, shouldPush bool) *messageAPI.Envelope {
	t.Helper()
	message, err := proto.Marshal(&mlsV1.GroupMessage{
		Version: &mlsV1.GroupMessage_V1_{V1: &mlsV1.GroupMessage_V1{
			Data:       data,
			SenderHmac: senderHMAC,
			ShouldPush: shouldPush,
		}},
	})
	if err != nil {
		t.Fatalf("marshal group message: %v", err)
	}
	return &messageAPI.Envelope{
		ContentTopic: testGroupTopic,
		TimestampNs:  uint64(time.Hour),
		Message:      message,
	}
}

func stringContainsBytes(encoded, raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	for start := 0; start+len(raw) <= len(encoded); start++ {
		match := true
		for offset := range raw {
			if encoded[start+offset] != raw[offset] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
