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

func TestControlPageSizesRespectD1BindLimit(t *testing.T) {
	t.Run("snapshot", func(t *testing.T) {
		setRequiredConfig(t)
		t.Setenv("SNAPSHOT_PAGE_SIZE", "101")
		t.Setenv("DELTA_PAGE_SIZE", "100")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "SNAPSHOT_PAGE_SIZE") {
			t.Fatalf("loadConfig() error = %v; want SNAPSHOT_PAGE_SIZE limit error", err)
		}
	})

	t.Run("delta", func(t *testing.T) {
		setRequiredConfig(t)
		t.Setenv("SNAPSHOT_PAGE_SIZE", "100")
		t.Setenv("DELTA_PAGE_SIZE", "101")
		_, err := loadConfig()
		if err == nil || !strings.Contains(err.Error(), "DELTA_PAGE_SIZE") {
			t.Fatalf("loadConfig() error = %v; want DELTA_PAGE_SIZE limit error", err)
		}
	})
}
