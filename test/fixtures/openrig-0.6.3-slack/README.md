# OpenRig 0.6.3 Slack gateway (pristine, for tests)

`daemon/dist/domain/gateway/slack/{slack-api,slack-delivery,message,queue-access}.js` copied unmodified from the published
`@openrig/cli@0.6.3` (only the trailing `sourceMappingURL` comments removed). OpenRig is licensed under the Apache
License 2.0 (https://github.com/mvschwarz/openrig). `test/openrig-slack-upload.test.js` applies
`patches/openrig/0.6.3/141-slack-upload-encoding-and-video.patch` to a copy and runs it against a stubbed `fetch`.
`test/openrig-slack-sweep.test.js` applies `patches/openrig/0.6.3/147-slack-sweep-active-ids-first.patch` to a copy of
`queue-access.js` (its two imports stubbed) and compares it with the pristine file on the same queue.
