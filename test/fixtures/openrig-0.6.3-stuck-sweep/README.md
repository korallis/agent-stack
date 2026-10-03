# OpenRig 0.6.3 queue stuck sweep (pristine, for tests)

`daemon/dist/domain/queue-stuck-sweep.js` copied unmodified from the published `@openrig/cli@0.6.3` (only the trailing
`sourceMappingURL` comment removed). OpenRig is licensed under the Apache License 2.0
(https://github.com/mvschwarz/openrig). `test/openrig-stuck-sweep-human-decisions.test.js` applies
`patches/openrig/0.6.3/133-unclaimed-human-routes-to-source.patch` and then `149-sweep-skips-human-decisions.patch` to
copies (their imports stubbed), and runs the sweep on a real SQLite queue table with and without 149.
