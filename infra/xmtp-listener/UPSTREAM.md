# Upstream XMTP Reference

The listener behavior is adapted from XMTP's official
`example-notification-server-go` at commit:

```text
0b22838ede4d0b550a3ea2c8465446ed2ce02bc2
```

The protocol dependency is pinned to:

```text
github.com/xmtp/xmtpd v1.3.1-0.20260402033823-6ae509c61de3
```

Adapted reference behavior includes production v3 `SubscribeAll`, MLS group
message parsing, `shouldPush`, sender-HMAC suppression, welcome/group topic
classification, and stable envelope idempotency hashing.

vapid.party intentionally replaces the reference server's PostgreSQL and public
Connect registration API with authenticated Worker snapshot/delta APIs backed by
D1. It also adds app-scoped route isolation, atomic in-memory index replacement,
strict canonical topic/installation validation, bounded control and stream
freshness, and a minimal delivery contract that never forwards ciphertext.

## Upgrade Procedure

1. Review the latest official reference server and `xmtpd` release notes.
2. Diff stream subscription, envelope protobufs, HMAC epoch calculation,
   sender-HMAC input, `shouldPush`, topic formats, and idempotency behavior against
   the pinned versions above.
3. Update the commit and module pins together. Do not silently move to another
   production network or add XMTP v4 until XMTP documents a production endpoint
   and compatible notification semantics.
4. Run all unit tests, especially cross-app HMAC isolation and minimal-payload
   tests, then build the container from a clean context.
5. Deploy as a canary and complete every step in `CANARY.md` before replacing
   the production singleton.
