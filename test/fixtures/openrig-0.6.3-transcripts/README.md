# OpenRig 0.6.3 transcript rotation (pristine, for tests)

`daemon/dist/domain/transcript-rotation.js` and `daemon/dist/openrig-compat.js` (its one local import) copied
unmodified from the published `@openrig/cli@0.6.3` (only the trailing `sourceMappingURL` comments removed). OpenRig is
licensed under the Apache License 2.0 (https://github.com/mvschwarz/openrig).
`test/openrig-batched-transcripts.test.js` applies `patches/openrig/0.6.3/144-batched-transcript-capture.patch` to a
copy and drives the rotation against a fake terminal adapter.
