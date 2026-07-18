package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // Matches the pinned XMTP reference server's idempotency key.
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	messageAPI "github.com/xmtp/xmtpd/pkg/proto/message_api/v1"
	mlsV1 "github.com/xmtp/xmtpd/pkg/proto/mls/api/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

const (
	messageTypeWelcome      = "v3-welcome"
	messageTypeConversation = "v3-conversation"
	streamStartingBackoff   = 100 * time.Millisecond
	streamMaximumBackoff    = 30 * time.Second
	pinnedUpstreamCommit    = "0b22838ede4d0b550a3ea2c8465446ed2ce02bc2"
)

type envelopeContext struct {
	MessageType string
	ShouldPush  bool
	HMACInputs  []byte
	SenderHMAC  []byte
}

type xmtpListener struct {
	cfg      config
	index    *indexManager
	state    *runtimeState
	delivery *deliveryClient
	logger   *slog.Logger
	messages chan *messageAPI.Envelope
}

func newXMTPListener(
	cfg config,
	index *indexManager,
	state *runtimeState,
	delivery *deliveryClient,
	logger *slog.Logger,
) *xmtpListener {
	return &xmtpListener{
		cfg:      cfg,
		index:    index,
		state:    state,
		delivery: delivery,
		logger:   logger,
		messages: make(chan *messageAPI.Envelope, 100),
	}
}

func (l *xmtpListener) Run(ctx context.Context) {
	var workers sync.WaitGroup
	for worker := 0; worker < l.cfg.WorkerCount; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for envelope := range l.messages {
				l.processEnvelope(ctx, envelope)
			}
		}()
	}

	l.streamLoop(ctx)
	close(l.messages)
	workers.Wait()
}

func (l *xmtpListener) streamLoop(ctx context.Context) {
	backoff := streamStartingBackoff
	for ctx.Err() == nil {
		connection, client, err := l.newClient()
		if err != nil {
			l.logger.Error("failed to create XMTP client", "error", err)
			if !sleepWithContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		stream, err := client.SubscribeAll(ctx, &messageAPI.SubscribeAllRequest{})
		if err != nil {
			_ = connection.Close()
			if ctx.Err() != nil {
				return
			}
			l.logger.Error("failed to connect XMTP SubscribeAll stream", "error", err)
			if !sleepWithContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		l.state.markStreamConnected(time.Now().UTC())
		l.logger.Info("XMTP SubscribeAll stream connected", "address", l.cfg.XMTPAddress)
		for {
			envelope, receiveError := stream.Recv()
			if receiveError != nil {
				l.state.markStreamDisconnected()
				_ = connection.Close()
				if ctx.Err() != nil {
					return
				}
				if errors.Is(receiveError, io.EOF) {
					l.logger.Warn("XMTP stream closed")
				} else {
					l.logger.Warn("XMTP stream receive failed", "error", receiveError)
				}
				break
			}
			if envelope == nil {
				continue
			}
			now := time.Now().UTC()
			l.state.markEnvelope(now)
			backoff = streamStartingBackoff
			select {
			case l.messages <- envelope:
			case <-ctx.Done():
				l.state.markStreamDisconnected()
				_ = connection.Close()
				return
			}
		}

		if !sleepWithContext(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

func (l *xmtpListener) newClient() (*grpc.ClientConn, messageAPI.MessageApiClient, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	connection, err := grpc.NewClient(
		l.cfg.XMTPAddress,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
		grpc.WithConnectParams(grpc.ConnectParams{MinConnectTimeout: 5 * time.Second}),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 5 * time.Minute, Timeout: 20 * time.Second}),
		grpc.WithUnaryInterceptor(versionUnaryInterceptor(l.cfg.AppVersion)),
		grpc.WithStreamInterceptor(versionStreamInterceptor(l.cfg.AppVersion)),
	)
	if err != nil {
		return nil, nil, err
	}
	return connection, messageAPI.NewMessageApiClient(connection), nil
}

func (l *xmtpListener) processEnvelope(ctx context.Context, envelope *messageAPI.Envelope) {
	if envelope == nil || !canonicalTopic.MatchString(envelope.ContentTopic) {
		return
	}
	index := l.index.Current()
	state := l.state.view()
	if ready, code := healthStatus(
		time.Now().UTC(),
		l.cfg.ControlMaxStaleness,
		l.cfg.StreamStartupGrace,
		l.cfg.StreamMaxIdle,
		l.cfg.DeliveryProbeMaxStaleness,
		state,
		index,
	); !ready && code != errorStreamDisconnected {
		l.logger.Warn("skipping envelope while registration index is unavailable", "reason", code)
		return
	}

	targets := l.index.Lookup(envelope.ContentTopic)
	if len(targets) == 0 {
		return
	}
	messageContext := contextFromEnvelope(envelope)
	if !messageContext.ShouldPush {
		return
	}
	epoch := thirtyDayPeriod(envelope.TimestampNs)
	idempotencyKey := buildIdempotencyKey(envelope)

	for _, target := range targets {
		if isSenderForTarget(messageContext, target, epoch) {
			continue
		}
		event := deliveryEvent{
			Version:        1,
			IdempotencyKey: idempotencyKey,
			InstallationID: target.InstallationID,
			DeliveryToken:  target.DeliveryToken,
			Topic:          target.Topic,
			MessageType:    messageContext.MessageType,
			ShouldPush:     true,
			IsSilent:       target.IsSilent,
		}
		if err := l.delivery.Deliver(ctx, event); err != nil {
			l.logger.Error(
				"delivery ingest failed",
				"failure_category", "upstream_unavailable",
			)
		}
	}
}

func contextFromEnvelope(envelope *messageAPI.Envelope) envelopeContext {
	if envelope == nil {
		return envelopeContext{}
	}
	if len(envelope.ContentTopic) > len("/xmtp/mls/1/") && envelope.ContentTopic[len("/xmtp/mls/1/")] == 'w' {
		return envelopeContext{MessageType: messageTypeWelcome, ShouldPush: true}
	}

	messageContext := envelopeContext{MessageType: messageTypeConversation}
	var groupMessage mlsV1.GroupMessage
	if err := proto.Unmarshal(envelope.Message, &groupMessage); err != nil {
		return messageContext
	}
	message := groupMessage.GetV1()
	if message == nil {
		return messageContext
	}
	messageContext.ShouldPush = message.ShouldPush
	messageContext.HMACInputs = message.Data
	messageContext.SenderHMAC = message.SenderHmac
	return messageContext
}

func isSenderForTarget(messageContext envelopeContext, target deliveryTarget, epoch int) bool {
	if len(messageContext.HMACInputs) == 0 || len(messageContext.SenderHMAC) == 0 {
		return false
	}
	for _, key := range target.HMACKeys[epoch] {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(messageContext.HMACInputs)
		if hmac.Equal(messageContext.SenderHMAC, mac.Sum(nil)) {
			return true
		}
	}
	return false
}

func thirtyDayPeriod(timestampNanoseconds uint64) int {
	return int(timestampNanoseconds / 1_000_000_000 / 60 / 60 / 24 / 30)
}

func buildIdempotencyKey(envelope *messageAPI.Envelope) string {
	hash := sha1.New()
	_, _ = hash.Write([]byte(envelope.ContentTopic))
	_, _ = hash.Write(envelope.Message)
	_, _ = hash.Write(binary.BigEndian.AppendUint64(nil, envelope.TimestampNs))
	return hex.EncodeToString(hash.Sum(nil))
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > streamMaximumBackoff {
		return streamMaximumBackoff
	}
	return next
}

func sleepWithContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func appendVersionMetadata(ctx context.Context, appVersion string) context.Context {
	ctx = metadata.AppendToOutgoingContext(ctx, "x-client-version", "vapid-party-xmtp-listener/"+pinnedUpstreamCommit[:7])
	ctx = metadata.AppendToOutgoingContext(ctx, "x-app-version", appVersion)
	return ctx
}

func versionUnaryInterceptor(appVersion string) grpc.UnaryClientInterceptor {
	return func(
		ctx context.Context,
		method string,
		request any,
		reply any,
		connection *grpc.ClientConn,
		invoker grpc.UnaryInvoker,
		options ...grpc.CallOption,
	) error {
		return invoker(appendVersionMetadata(ctx, appVersion), method, request, reply, connection, options...)
	}
}

func versionStreamInterceptor(appVersion string) grpc.StreamClientInterceptor {
	return func(
		ctx context.Context,
		description *grpc.StreamDesc,
		connection *grpc.ClientConn,
		method string,
		streamer grpc.Streamer,
		options ...grpc.CallOption,
	) (grpc.ClientStream, error) {
		return streamer(appendVersionMetadata(ctx, appVersion), description, connection, method, options...)
	}
}
