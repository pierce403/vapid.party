package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultXMTPAddress     = "grpc.production.xmtp.network:443"
	defaultListenAddr      = ":8080"
	defaultControlPageSize = 10
	maxControlPageSize     = 10
)

type config struct {
	ListenAddress             string
	XMTPAddress               string
	ControlPlaneBaseURL       string
	DeliveryURL               string
	SyncToken                 string
	IngestToken               string
	InstanceID                string
	AppVersion                string
	SnapshotPageSize          int
	DeltaPageSize             int
	ControlPollInterval       time.Duration
	ControlMaxStaleness       time.Duration
	StreamStartupGrace        time.Duration
	StreamMaxIdle             time.Duration
	StatusReportInterval      time.Duration
	DeliveryProbeInterval     time.Duration
	DeliveryProbeMaxStaleness time.Duration
	HTTPTimeout               time.Duration
	DeliveryAttempts          int
	WorkerCount               int
}

func loadConfig() (config, error) {
	hostname, _ := os.Hostname()
	instanceID := firstNonEmpty(os.Getenv("INSTANCE_ID"), os.Getenv("CLOUDFLARE_DURABLE_OBJECT_ID"), hostname)
	if instanceID == "" {
		instanceID = "unknown"
	}

	cfg := config{
		ListenAddress:             envOrDefault("LISTEN_ADDRESS", defaultListenAddr),
		XMTPAddress:               envOrDefault("XMTP_GRPC_ADDRESS", defaultXMTPAddress),
		ControlPlaneBaseURL:       strings.TrimRight(os.Getenv("VAPID_PARTY_CONTROL_URL"), "/"),
		DeliveryURL:               os.Getenv("VAPID_PARTY_DELIVERY_URL"),
		SyncToken:                 os.Getenv("XMTP_LISTENER_SYNC_TOKEN"),
		IngestToken:               os.Getenv("INTERNAL_INGEST_TOKEN"),
		InstanceID:                instanceID,
		AppVersion:                envOrDefault("APP_VERSION", "vapid-party-xmtp-listener/unknown"),
		SnapshotPageSize:          defaultControlPageSize,
		DeltaPageSize:             defaultControlPageSize,
		ControlPollInterval:       15 * time.Second,
		ControlMaxStaleness:       2 * time.Minute,
		StreamStartupGrace:        2 * time.Minute,
		StreamMaxIdle:             3 * time.Minute,
		StatusReportInterval:      30 * time.Second,
		DeliveryProbeInterval:     15 * time.Second,
		DeliveryProbeMaxStaleness: time.Minute,
		HTTPTimeout:               15 * time.Second,
		DeliveryAttempts:          5,
		WorkerCount:               4,
	}

	var err error
	if cfg.SnapshotPageSize, err = intEnv("SNAPSHOT_PAGE_SIZE", cfg.SnapshotPageSize, 1, maxControlPageSize); err != nil {
		return config{}, err
	}
	if cfg.DeltaPageSize, err = intEnv("DELTA_PAGE_SIZE", cfg.DeltaPageSize, 1, maxControlPageSize); err != nil {
		return config{}, err
	}
	if cfg.DeliveryAttempts, err = intEnv("DELIVERY_ATTEMPTS", cfg.DeliveryAttempts, 1, 10); err != nil {
		return config{}, err
	}
	if cfg.WorkerCount, err = intEnv("MESSAGE_WORKERS", cfg.WorkerCount, 1, 64); err != nil {
		return config{}, err
	}
	if cfg.ControlPollInterval, err = durationEnv("CONTROL_POLL_INTERVAL", cfg.ControlPollInterval, time.Second); err != nil {
		return config{}, err
	}
	if cfg.ControlMaxStaleness, err = durationEnv("CONTROL_MAX_STALENESS", cfg.ControlMaxStaleness, cfg.ControlPollInterval*2); err != nil {
		return config{}, err
	}
	if cfg.StreamStartupGrace, err = durationEnv("STREAM_STARTUP_GRACE", cfg.StreamStartupGrace, 30*time.Second); err != nil {
		return config{}, err
	}
	if cfg.StreamMaxIdle, err = durationEnv("STREAM_MAX_IDLE", cfg.StreamMaxIdle, time.Minute); err != nil {
		return config{}, err
	}
	if cfg.StatusReportInterval, err = durationEnv("STATUS_REPORT_INTERVAL", cfg.StatusReportInterval, 5*time.Second); err != nil {
		return config{}, err
	}
	if cfg.DeliveryProbeInterval, err = durationEnv("DELIVERY_PROBE_INTERVAL", cfg.DeliveryProbeInterval, 5*time.Second); err != nil {
		return config{}, err
	}
	if cfg.DeliveryProbeMaxStaleness, err = durationEnv("DELIVERY_PROBE_MAX_STALENESS", cfg.DeliveryProbeMaxStaleness, cfg.DeliveryProbeInterval*2); err != nil {
		return config{}, err
	}
	if cfg.HTTPTimeout, err = durationEnv("HTTP_TIMEOUT", cfg.HTTPTimeout, time.Second); err != nil {
		return config{}, err
	}

	if strings.Contains(cfg.XMTPAddress, "://") {
		return config{}, errors.New("XMTP_GRPC_ADDRESS must be a bare host:port, not a URL")
	}
	if err := requireHTTPURL("VAPID_PARTY_CONTROL_URL", cfg.ControlPlaneBaseURL); err != nil {
		return config{}, err
	}
	if err := requireHTTPURL("VAPID_PARTY_DELIVERY_URL", cfg.DeliveryURL); err != nil {
		return config{}, err
	}
	if strings.TrimSpace(cfg.SyncToken) == "" {
		return config{}, errors.New("XMTP_LISTENER_SYNC_TOKEN is required")
	}
	if strings.TrimSpace(cfg.IngestToken) == "" {
		return config{}, errors.New("INTERNAL_INGEST_TOKEN is required")
	}
	return cfg, nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func intEnv(name string, fallback, minValue, maxValue int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minValue || value > maxValue {
		return 0, fmt.Errorf("%s must be an integer from %d through %d", name, minValue, maxValue)
	}
	return value, nil
}

func durationEnv(name string, fallback, minValue time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < minValue {
		return 0, fmt.Errorf("%s must be a duration of at least %s", name, minValue)
	}
	return value, nil
}

func requireHTTPURL(name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("%s must be an absolute HTTP(S) URL", name)
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return fmt.Errorf("%s must not contain credentials or a fragment", name)
	}
	return nil
}
