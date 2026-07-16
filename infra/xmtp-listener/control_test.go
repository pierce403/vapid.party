package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewControlClientCapsProgrammaticPageSizes(t *testing.T) {
	t.Parallel()

	client := newControlClient(config{
		ControlPlaneBaseURL: "https://vapid.party",
		SyncToken:           "sync-secret",
		SnapshotPageSize:    100,
		DeltaPageSize:       100,
		HTTPTimeout:         time.Second,
	})
	if client.snapshotSize != 10 || client.deltaSize != 10 {
		t.Fatalf(
			"control page sizes = snapshot %d, delta %d; want 10, 10",
			client.snapshotSize,
			client.deltaSize,
		)
	}
}

func TestControlClientPaginatesAuthenticatesAndAcceptsAdditiveFields(t *testing.T) {
	t.Parallel()

	var (
		mu             sync.Mutex
		statusReceived listenerStatus
	)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer sync-secret" {
			t.Errorf("Authorization = %q; want sync bearer token", got)
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/internal/xmtp/listener/snapshot":
			if request.URL.Query().Get("limit") != "1" {
				t.Errorf("snapshot limit = %q; want 1", request.URL.Query().Get("limit"))
			}
			if request.URL.Query().Get("pageToken") == "" {
				fmt.Fprintf(response, `{
					"version":1,
					"cursor":"10",
					"registrations":[{
						"appId":"converge",
						"installationId":"%s",
						"deliveryToken":"token-a",
						"topics":[{"topic":"%s","isSilent":false,"hmacKeys":[{"thirtyDayPeriodsSinceEpoch":0,"key":"a2V5LWE=","futureKeyField":true}]}],
						"futureRegistrationField":{"ok":true}
					}],
					"nextPageToken":"page-2",
					"futureRootField":123
				}`, testInstallationID, testGroupTopic)
				return
			}
			if got := request.URL.Query().Get("pageToken"); got != "page-2" {
				t.Errorf("snapshot page token = %q; want page-2", got)
			}
			fmt.Fprintf(response, `{
				"version":1,
				"cursor":"10",
				"registrations":[{
					"appId":"farcaster-miniapp",
					"installationId":"%s",
					"deliveryToken":"token-b",
					"topics":[{"topic":"%s","isSilent":true,"hmacKeys":[{"thirtyDayPeriodsSinceEpoch":0,"key":"a2V5LWI="}]}]
				}]
			}`, testInstallationID, testGroupTopic)
		case "/api/internal/xmtp/listener/deltas":
			if request.URL.Query().Get("limit") != "1" {
				t.Errorf("delta limit = %q; want 1", request.URL.Query().Get("limit"))
			}
			switch request.URL.Query().Get("after") {
			case "10":
				fmt.Fprintf(response, `{
					"version":1,"cursor":"11","hasMore":true,
					"changes":[{"sequence":"11","appId":"converge","installationId":"%s","deliveryToken":"token-a","registration":null}],
					"futureRootField":"ignored"
				}`, testInstallationID)
			case "11":
				fmt.Fprint(response, `{"version":1,"cursor":"12","hasMore":false,"changes":[]}`)
			default:
				t.Errorf("unexpected delta cursor %q", request.URL.Query().Get("after"))
				response.WriteHeader(http.StatusBadRequest)
			}
		case "/api/internal/xmtp/listener/status":
			if request.Method != http.MethodPost {
				t.Errorf("status method = %s; want POST", request.Method)
			}
			mu.Lock()
			defer mu.Unlock()
			if err := json.NewDecoder(request.Body).Decode(&statusReceived); err != nil {
				t.Errorf("decode status: %v", err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	client := &controlClient{
		baseURL:      server.URL,
		token:        "sync-secret",
		snapshotSize: 1,
		deltaSize:    1,
		httpClient:   server.Client(),
	}
	cursor, registrations, err := client.FetchSnapshot(context.Background())
	if err != nil {
		t.Fatalf("FetchSnapshot() error = %v", err)
	}
	if cursor != "10" || len(registrations) != 2 {
		t.Fatalf("snapshot = cursor %q, %d registrations; want 10, 2", cursor, len(registrations))
	}
	cursor, changes, err := client.FetchDeltas(context.Background(), cursor)
	if err != nil {
		t.Fatalf("FetchDeltas() error = %v", err)
	}
	if cursor != "12" || len(changes) != 1 || changes[0].AppID != "converge" {
		t.Fatalf("deltas = cursor %q, %#v; want cursor 12 and one Converge deletion", cursor, changes)
	}

	status := listenerStatus{
		Version:    1,
		InstanceID: "primary",
		Ready:      true,
		Cursor:     "12",
		ObservedAt: time.Unix(100, 0).UTC().Format(time.RFC3339Nano),
	}
	if err := client.ReportStatus(context.Background(), status); err != nil {
		t.Fatalf("ReportStatus() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if statusReceived.InstanceID != status.InstanceID || statusReceived.Cursor != status.Cursor {
		t.Fatalf("received status = %#v; want %#v", statusReceived, status)
	}
}

func TestFetchDeltasRejectsNonAdvancingPagination(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"version":1,"cursor":"10","hasMore":true,"changes":[]}`)
	}))
	defer server.Close()
	client := &controlClient{baseURL: server.URL, token: "secret", deltaSize: 100, httpClient: server.Client()}
	if _, _, err := client.FetchDeltas(context.Background(), "10"); err == nil {
		t.Fatal("FetchDeltas() accepted a non-advancing hasMore response")
	}
}

func TestFetchDeltasForcesSnapshotReloadAtAggregateChangeBudget(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		response.Header().Set("Content-Type", "application/json")
		after := request.URL.Query().Get("after")
		var cursor string
		switch after {
		case "10":
			cursor = "11"
		case "11":
			cursor = "12"
		case "12":
			cursor = "13"
		default:
			t.Errorf("unexpected delta cursor %q", after)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		fmt.Fprintf(response, `{
			"version":1,
			"cursor":%q,
			"hasMore":true,
			"changes":[{
				"sequence":%q,
				"appId":"converge",
				"installationId":%q,
				"deliveryToken":"token-a",
				"registration":null
			}]
		}`, cursor, cursor, testInstallationID)
	}))
	defer server.Close()

	client := &controlClient{
		baseURL:             server.URL,
		token:               "secret",
		deltaSize:           1,
		deltaChangeBudget:   2,
		deltaResponseBudget: 1 << 20,
		httpClient:          server.Client(),
	}
	_, changes, err := client.FetchDeltas(context.Background(), "10")
	if !errors.Is(err, errDeltaSyncBudgetExceeded) {
		t.Fatalf("FetchDeltas() error = %v; want delta budget error", err)
	}
	if changes != nil {
		t.Fatalf("FetchDeltas() retained %d partial changes after budget failure", len(changes))
	}
	if !shouldReloadSnapshot(err) {
		t.Fatal("delta budget error did not request a fresh snapshot")
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("delta requests = %d; want 3", got)
	}
}

func TestFetchDeltasForcesSnapshotReloadAtAggregateByteBudget(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(response, `{
			"version":1,
			"cursor":"11",
			"hasMore":false,
			"changes":[],
			"futureField":%q
		}`, strings.Repeat("x", 512))
	}))
	defer server.Close()

	client := &controlClient{
		baseURL:             server.URL,
		token:               "secret",
		deltaSize:           1,
		deltaChangeBudget:   10,
		deltaResponseBudget: 128,
		httpClient:          server.Client(),
	}
	_, _, err := client.FetchDeltas(context.Background(), "10")
	if !errors.Is(err, errDeltaSyncBudgetExceeded) {
		t.Fatalf("FetchDeltas() error = %v; want delta byte budget error", err)
	}
	if !shouldReloadSnapshot(err) {
		t.Fatal("delta byte budget error did not request a fresh snapshot")
	}
}
