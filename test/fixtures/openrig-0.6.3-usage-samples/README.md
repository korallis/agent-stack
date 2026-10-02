# OpenRig 0.6.3 usage samples store (pristine, for tests)

`daemon/dist/domain/usage-samples-store.js` and `daemon/dist/db/migrations/062_usage_samples.js` (the table and its
indexes) copied unmodified from the published `@openrig/cli@0.6.3` (only the trailing `sourceMappingURL` comments
removed). OpenRig is licensed under the Apache License 2.0 (https://github.com/mvschwarz/openrig).
`test/openrig-usage-samples-lookup.test.js` applies `patches/openrig/0.6.3/145-usage-samples-latest-by-index.patch` to a
copy and runs the store against a real SQLite database.
