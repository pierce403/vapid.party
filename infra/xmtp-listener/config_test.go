package main

import (
	"strings"
	"testing"
)

func setRequiredConfig(t *testing.T) {
	t.Helper()
	t.Setenv("VAPID_PARTY_CONTROL_URL", "https://vapid.party")
	t.Setenv("VAPID_PARTY_DELIVERY_URL", "https://vapid.party/api/internal/xmtp/deliveries")
	t.Setenv("XMTP_LISTENER_SYNC_TOKEN", "sync-token")
	t.Setenv("INTERNAL_INGEST_TOKEN", "ingest-token")
}

func TestControlPageSizesDefaultToTen(t *testing.T) {
	setRequiredConfig(t)
	t.Setenv("SNAPSHOT_PAGE_SIZE", "")
	t.Setenv("DELTA_PAGE_SIZE", "")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}
	if cfg.SnapshotPageSize != 10 || cfg.DeltaPageSize != 10 {
		t.Fatalf(
			"control page sizes = snapshot %d, delta %d; want 10, 10",
			cfg.SnapshotPageSize,
			cfg.DeltaPageSize,
		)
	}
}

func TestControlPageSizesAreCappedAtTen(t *testing.T) {
	t.Run("snapshot", func(t *testing.T) {
		setRequiredConfig(t)
		t.Setenv("SNAPSHOT_PAGE_SIZE", "11")
		t.Setenv("DELTA_PAGE_SIZE", "10")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "SNAPSHOT_PAGE_SIZE") {
			t.Fatalf("loadConfig() error = %v; want SNAPSHOT_PAGE_SIZE limit error", err)
		}
	})

	t.Run("delta", func(t *testing.T) {
		setRequiredConfig(t)
		t.Setenv("SNAPSHOT_PAGE_SIZE", "10")
		t.Setenv("DELTA_PAGE_SIZE", "11")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "DELTA_PAGE_SIZE") {
			t.Fatalf("loadConfig() error = %v; want DELTA_PAGE_SIZE limit error", err)
		}
	})
}
