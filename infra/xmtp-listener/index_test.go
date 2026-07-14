package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const (
	testInstallationID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testGroupID        = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testGroupTopic     = "/xmtp/mls/1/g-" + testGroupID + "/proto"
)

func TestIndexKeepsAppRoutesAndHMACKeysSeparate(t *testing.T) {
	t.Parallel()

	keyA := []byte("app-a-hmac-key")
	keyB := []byte("app-b-hmac-key")
	index := newIndexManager()
	registrations := []registration{
		testRegistration("converge", "token-a", keyA),
		testRegistration("farcaster-miniapp", "token-b", keyB),
	}

	if err := index.Replace("10", registrations, time.Unix(10, 0)); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}

	snapshot := index.Current()
	if snapshot.RegistrationCount != 2 || snapshot.TopicCount != 2 {
		t.Fatalf("counts = %d registrations, %d topics; want 2, 2", snapshot.RegistrationCount, snapshot.TopicCount)
	}
	targets := index.Lookup(testGroupTopic)
	if len(targets) != 2 {
		t.Fatalf("Lookup() returned %d targets; want 2", len(targets))
	}

	keysByToken := make(map[string][][]byte)
	for _, target := range targets {
		keysByToken[target.DeliveryToken] = target.HMACKeys[0]
	}
	if got := string(keysByToken["token-a"][0]); got != string(keyA) {
		t.Fatalf("token-a key = %q; want %q", got, keyA)
	}
	if got := string(keysByToken["token-b"][0]); got != string(keyB) {
		t.Fatalf("token-b key = %q; want %q", got, keyB)
	}
}

func TestDeltaDeletesOnlyNamedAppRoute(t *testing.T) {
	t.Parallel()

	index := newIndexManager()
	if err := index.Replace("10", []registration{
		testRegistration("converge", "token-a", []byte("key-a")),
		testRegistration("farcaster-miniapp", "token-b", []byte("key-b")),
	}, time.Unix(10, 0)); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}

	if err := index.ApplyDeltas("11", []deltaChange{{
		Sequence:       "11",
		AppID:          "converge",
		InstallationID: testInstallationID,
		DeliveryToken:  "token-a",
		Registration:   nil,
	}}, time.Unix(11, 0)); err != nil {
		t.Fatalf("ApplyDeltas() error = %v", err)
	}

	snapshot := index.Current()
	if snapshot.RegistrationCount != 1 {
		t.Fatalf("RegistrationCount = %d; want 1", snapshot.RegistrationCount)
	}
	targets := index.Lookup(testGroupTopic)
	if len(targets) != 1 || targets[0].DeliveryToken != "token-b" {
		t.Fatalf("remaining targets = %#v; want only token-b", targets)
	}
}

func TestIndexRejectsCrossRouteDeltaAndNonCanonicalTopic(t *testing.T) {
	t.Parallel()

	index := newIndexManager()
	if err := index.Replace("10", []registration{
		testRegistration("converge", "token-a", []byte("key-a")),
	}, time.Unix(10, 0)); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}

	other := testRegistration("other-app", "token-b", []byte("key-b"))
	err := index.ApplyDeltas("11", []deltaChange{{
		Sequence:       "11",
		AppID:          "converge",
		InstallationID: testInstallationID,
		DeliveryToken:  "token-a",
		Registration:   &other,
	}}, time.Unix(11, 0))
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("ApplyDeltas() error = %v; want route mismatch", err)
	}

	bad := testRegistration("converge", "token-a", []byte("key-a"))
	bad.Topics[0].Topic = "/xmtp/mls/1/g-" + strings.ToUpper(testGroupID) + "/proto"
	if err := index.Replace("12", []registration{bad}, time.Unix(12, 0)); err == nil {
		t.Fatal("Replace() accepted a non-canonical topic")
	}

	badLength := testRegistration("converge", "token-a", []byte("key-a"))
	badLength.Topics[0].Topic = "/xmtp/mls/1/g-" + strings.Repeat("b", 64) + "/proto"
	if err := index.Replace("12", []registration{badLength}, time.Unix(12, 0)); err == nil {
		t.Fatal("Replace() accepted a 32-byte group identifier")
	}
}

func testRegistration(appID, token string, hmacKey []byte) registration {
	return registration{
		AppID:          appID,
		InstallationID: testInstallationID,
		DeliveryToken:  token,
		Topics: []topicRegistration{{
			Topic: testGroupTopic,
			HMACKeys: []hmacKeyRecord{{
				ThirtyDayPeriodsSinceEpoch: 0,
				Key:                        base64.StdEncoding.EncodeToString(hmacKey),
			}},
		}},
	}
}
