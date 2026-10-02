# OpenRig 0.6.3 queue recovery lookup (pristine, for tests)

`daemon/dist/domain/queue-recovery.js` copied unmodified from the published `@openrig/cli@0.6.3` (only the trailing
`sourceMappingURL` comment removed). OpenRig is licensed under the Apache License 2.0
(https://github.com/mvschwarz/openrig). `test/openrig-queue-list-recovery.test.js` applies the `queue-recovery.js` part
of `patches/openrig/0.6.3/148-queue-list-recovery-once.patch` to a copy (its one import stubbed) and compares the
scoped lookup with the original query on a real SQLite table.
