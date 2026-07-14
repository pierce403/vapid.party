package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

var (
	canonicalInstallationID = regexp.MustCompile(`^[0-9a-f]{64}$`)
	canonicalTopic          = regexp.MustCompile(`^/xmtp/mls/1/(g-[0-9a-f]{32}|w-[0-9a-f]{64})/proto$`)
)

type hmacKeyRecord struct {
	ThirtyDayPeriodsSinceEpoch int    `json:"thirtyDayPeriodsSinceEpoch"`
	Key                        string `json:"key"`
}

type topicRegistration struct {
	Topic    string          `json:"topic"`
	IsSilent bool            `json:"isSilent"`
	HMACKeys []hmacKeyRecord `json:"hmacKeys"`
}

type registration struct {
	AppID          string              `json:"appId"`
	InstallationID string              `json:"installationId"`
	DeliveryToken  string              `json:"deliveryToken"`
	Topics         []topicRegistration `json:"topics"`
}

type deltaChange struct {
	Sequence       string        `json:"sequence"`
	AppID          string        `json:"appId"`
	InstallationID string        `json:"installationId"`
	DeliveryToken  string        `json:"deliveryToken"`
	Registration   *registration `json:"registration"`
}

type deliveryTarget struct {
	InstallationID string
	DeliveryToken  string
	Topic          string
	IsSilent       bool
	HMACKeys       map[int][][]byte
}

type indexSnapshot struct {
	Cursor            string
	LoadedAt          time.Time
	Registrations     map[string]registration
	TargetsByTopic    map[string][]deliveryTarget
	RegistrationCount int
	TopicCount        int
}

type indexManager struct {
	current atomic.Pointer[indexSnapshot]
}

func newIndexManager() *indexManager {
	return &indexManager{}
}

func (m *indexManager) Current() *indexSnapshot {
	return m.current.Load()
}

func (m *indexManager) Replace(cursor string, registrations []registration, loadedAt time.Time) error {
	if cursor == "" {
		return errors.New("snapshot cursor is empty")
	}
	byRoute := make(map[string]registration, len(registrations))
	for _, item := range registrations {
		key := registrationKey(item.AppID, item.InstallationID)
		if _, exists := byRoute[key]; exists {
			return fmt.Errorf("duplicate app/installation route %q/%q in snapshot", item.AppID, item.InstallationID)
		}
		byRoute[key] = item
	}

	next, err := buildIndex(cursor, byRoute, loadedAt)
	if err != nil {
		return err
	}
	m.current.Store(next)
	return nil
}

func (m *indexManager) ApplyDeltas(cursor string, changes []deltaChange, loadedAt time.Time) error {
	current := m.current.Load()
	if current == nil {
		return errors.New("cannot apply deltas before a full snapshot")
	}
	if cursor == "" {
		return errors.New("delta cursor is empty")
	}

	registrations := make(map[string]registration, len(current.Registrations)+len(changes))
	for key, item := range current.Registrations {
		registrations[key] = item
	}
	for _, change := range changes {
		if err := validateAppID(change.AppID); err != nil {
			return fmt.Errorf("delta app id: %w", err)
		}
		if !canonicalInstallationID.MatchString(change.InstallationID) {
			return fmt.Errorf("delta has invalid installation id %q", change.InstallationID)
		}
		if change.Sequence == "" {
			return fmt.Errorf("delta for installation %q has no sequence", change.InstallationID)
		}
		if err := validateOpaqueToken(change.DeliveryToken); err != nil {
			return fmt.Errorf("delta delivery token: %w", err)
		}
		key := registrationKey(change.AppID, change.InstallationID)
		if change.Registration == nil {
			delete(registrations, key)
			continue
		}
		if change.Registration.AppID != change.AppID ||
			change.Registration.InstallationID != change.InstallationID ||
			change.Registration.DeliveryToken != change.DeliveryToken {
			return fmt.Errorf(
				"delta route %q/%q does not match registration %q/%q or its delivery token",
				change.AppID,
				change.InstallationID,
				change.Registration.AppID,
				change.Registration.InstallationID,
			)
		}
		registrations[key] = *change.Registration
	}

	next, err := buildIndex(cursor, registrations, loadedAt)
	if err != nil {
		return err
	}
	m.current.Store(next)
	return nil
}

func (m *indexManager) Lookup(topic string) []deliveryTarget {
	current := m.current.Load()
	if current == nil {
		return nil
	}
	return current.TargetsByTopic[topic]
}

func buildIndex(cursor string, registrations map[string]registration, loadedAt time.Time) (*indexSnapshot, error) {
	targetsByTopic := make(map[string][]deliveryTarget)
	topicCount := 0

	for key, item := range registrations {
		if key != registrationKey(item.AppID, item.InstallationID) {
			return nil, errors.New("registration map key does not match its app/installation route")
		}
		if err := validateAppID(item.AppID); err != nil {
			return nil, fmt.Errorf("registration app id: %w", err)
		}
		installationID := item.InstallationID
		if !canonicalInstallationID.MatchString(installationID) || installationID != item.InstallationID {
			return nil, fmt.Errorf("invalid installation id %q", item.InstallationID)
		}
		if err := validateOpaqueToken(item.DeliveryToken); err != nil {
			return nil, fmt.Errorf("installation %q delivery token: %w", installationID, err)
		}

		seenTopics := make(map[string]struct{}, len(item.Topics))
		for _, topic := range item.Topics {
			matches := canonicalTopic.FindStringSubmatch(topic.Topic)
			if matches == nil {
				return nil, fmt.Errorf("installation %q has non-canonical topic %q", installationID, topic.Topic)
			}
			if _, exists := seenTopics[topic.Topic]; exists {
				return nil, fmt.Errorf("installation %q repeats topic %q", installationID, topic.Topic)
			}
			seenTopics[topic.Topic] = struct{}{}

			isWelcome := strings.HasPrefix(matches[1], "w-")
			if isWelcome && len(topic.HMACKeys) != 0 {
				return nil, fmt.Errorf("welcome topic %q must not include HMAC keys", topic.Topic)
			}
			if !isWelcome && len(topic.HMACKeys) == 0 {
				return nil, fmt.Errorf("group topic %q must include at least one HMAC key", topic.Topic)
			}

			target := deliveryTarget{
				InstallationID: installationID,
				DeliveryToken:  item.DeliveryToken,
				Topic:          topic.Topic,
				IsSilent:       topic.IsSilent,
				HMACKeys:       make(map[int][][]byte),
			}
			for _, record := range topic.HMACKeys {
				if record.ThirtyDayPeriodsSinceEpoch < 0 {
					return nil, fmt.Errorf("topic %q has a negative HMAC epoch", topic.Topic)
				}
				key, err := decodeHMACKey(record.Key)
				if err != nil {
					return nil, fmt.Errorf("topic %q epoch %d: %w", topic.Topic, record.ThirtyDayPeriodsSinceEpoch, err)
				}
				target.HMACKeys[record.ThirtyDayPeriodsSinceEpoch] = append(
					target.HMACKeys[record.ThirtyDayPeriodsSinceEpoch],
					key,
				)
			}

			targetsByTopic[topic.Topic] = append(targetsByTopic[topic.Topic], target)
			topicCount++
		}
	}

	return &indexSnapshot{
		Cursor:            cursor,
		LoadedAt:          loadedAt,
		Registrations:     registrations,
		TargetsByTopic:    targetsByTopic,
		RegistrationCount: len(registrations),
		TopicCount:        topicCount,
	}, nil
}

func registrationKey(appID, installationID string) string {
	return appID + "\x00" + installationID
}

func validateAppID(value string) error {
	if value == "" || len(value) > 128 {
		return errors.New("must contain 1 through 128 characters")
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '.' && char != '-' && char != '_' {
			return errors.New("must contain only lowercase letters, digits, dot, dash, or underscore")
		}
	}
	return nil
}

func validateOpaqueToken(value string) error {
	if value == "" || len(value) > 255 {
		return errors.New("must contain 1 through 255 characters")
	}
	if strings.TrimSpace(value) != value {
		return errors.New("must not have surrounding whitespace")
	}
	for _, char := range value {
		if char < 0x21 || char > 0x7e {
			return errors.New("must contain printable ASCII without spaces")
		}
	}
	return nil
}

func decodeHMACKey(value string) ([]byte, error) {
	if value == "" || len(value) > 1024 {
		return nil, errors.New("HMAC key must contain 1 through 1024 base64 characters")
	}
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, encoding := range encodings {
		decoded, err := encoding.DecodeString(value)
		if err == nil && len(decoded) > 0 && len(decoded) <= 256 {
			return decoded, nil
		}
	}
	return nil, errors.New("HMAC key is not valid bounded base64")
}
