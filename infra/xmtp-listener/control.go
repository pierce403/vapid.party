package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxControlResponseBytes = 16 << 20

type snapshotPage struct {
	Version       int            `json:"version"`
	Cursor        string         `json:"cursor"`
	Registrations []registration `json:"registrations"`
	NextPageToken string         `json:"nextPageToken,omitempty"`
}

type deltaPage struct {
	Version int           `json:"version"`
	Cursor  string        `json:"cursor"`
	HasMore bool          `json:"hasMore"`
	Changes []deltaChange `json:"changes"`
}

type listenerStatus struct {
	Version             int    `json:"version"`
	InstanceID          string `json:"instanceId"`
	Ready               bool   `json:"ready"`
	Cursor              string `json:"cursor"`
	ObservedAt          string `json:"observedAt"`
	ErrorCode           string `json:"errorCode,omitempty"`
	StreamConnectedAt   string `json:"streamConnectedAt,omitempty"`
	LastEnvelopeAt      string `json:"lastEnvelopeAt,omitempty"`
	LastControlSyncAt   string `json:"lastControlSyncAt,omitempty"`
	RegistrationCount   int    `json:"registrationCount"`
	TopicCount          int    `json:"topicCount"`
	DeliveryReady       bool   `json:"deliveryReady"`
	LastDeliveryProbeAt string `json:"lastDeliveryProbeAt,omitempty"`
}

type controlClient struct {
	baseURL      string
	token        string
	snapshotSize int
	deltaSize    int
	httpClient   *http.Client
}

type controlHTTPError struct {
	StatusCode int
	Body       string
}

func (e *controlHTTPError) Error() string {
	return fmt.Sprintf("control plane returned HTTP %d: %s", e.StatusCode, e.Body)
}

func newControlClient(cfg config) *controlClient {
	return &controlClient{
		baseURL:      cfg.ControlPlaneBaseURL,
		token:        cfg.SyncToken,
		snapshotSize: cfg.SnapshotPageSize,
		deltaSize:    cfg.DeltaPageSize,
		httpClient:   &http.Client{Timeout: cfg.HTTPTimeout},
	}
}

func (c *controlClient) FetchSnapshot(ctx context.Context) (string, []registration, error) {
	var (
		cursor        string
		registrations []registration
		pageToken     string
	)
	seenTokens := make(map[string]struct{})

	for pageNumber := 0; pageNumber < 10_000; pageNumber++ {
		query := url.Values{"limit": {strconv.Itoa(c.snapshotSize)}}
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		var page snapshotPage
		if err := c.getJSON(ctx, "/api/internal/xmtp/listener/snapshot", query, &page); err != nil {
			return "", nil, err
		}
		if page.Version != 1 || page.Cursor == "" {
			return "", nil, errors.New("snapshot response has an unsupported version or empty cursor")
		}
		if cursor == "" {
			cursor = page.Cursor
		} else if cursor != page.Cursor {
			return "", nil, fmt.Errorf("snapshot cursor changed between pages: %q then %q", cursor, page.Cursor)
		}
		registrations = append(registrations, page.Registrations...)
		if page.NextPageToken == "" {
			return cursor, registrations, nil
		}
		if _, exists := seenTokens[page.NextPageToken]; exists {
			return "", nil, errors.New("snapshot pagination repeated a page token")
		}
		seenTokens[page.NextPageToken] = struct{}{}
		pageToken = page.NextPageToken
	}
	return "", nil, errors.New("snapshot exceeded the pagination safety limit")
}

func (c *controlClient) FetchDeltas(ctx context.Context, after string) (string, []deltaChange, error) {
	if after == "" {
		return "", nil, errors.New("delta cursor is empty")
	}
	cursor := after
	var changes []deltaChange

	for pageNumber := 0; pageNumber < 10_000; pageNumber++ {
		query := url.Values{
			"after": {cursor},
			"limit": {strconv.Itoa(c.deltaSize)},
		}
		var page deltaPage
		if err := c.getJSON(ctx, "/api/internal/xmtp/listener/deltas", query, &page); err != nil {
			return "", nil, err
		}
		if page.Version != 1 || page.Cursor == "" {
			return "", nil, errors.New("delta response has an unsupported version or empty cursor")
		}
		changes = append(changes, page.Changes...)
		if !page.HasMore {
			return page.Cursor, changes, nil
		}
		if page.Cursor == cursor {
			return "", nil, errors.New("delta response claims more pages without advancing its cursor")
		}
		cursor = page.Cursor
	}
	return "", nil, errors.New("deltas exceeded the pagination safety limit")
}

func (c *controlClient) ReportStatus(ctx context.Context, status listenerStatus) error {
	body, err := json.Marshal(status)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/api/internal/xmtp/listener/status",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return readControlHTTPError(response)
	}
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	return err
}

func (c *controlClient) getJSON(ctx context.Context, path string, query url.Values, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path+"?"+query.Encode(), nil)
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
	if response.StatusCode != http.StatusOK {
		return readControlHTTPError(response)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxControlResponseBytes))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode control response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("control response contains trailing JSON")
	}
	return nil
}

func readControlHTTPError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}
	return &controlHTTPError{StatusCode: response.StatusCode, Body: message}
}

func shouldReloadSnapshot(err error) bool {
	var httpError *controlHTTPError
	return errors.As(err, &httpError) && (httpError.StatusCode == http.StatusConflict || httpError.StatusCode == http.StatusGone)
}

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
