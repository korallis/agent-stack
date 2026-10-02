# OpenRig 0.6.3 terminal adapter (pristine, for tests)

`daemon/dist/adapters/tmux.js` and `daemon/dist/domain/seat-delivery-guard.js` (its one local import) copied unmodified
from the published `@openrig/cli@0.6.3` (only the trailing `sourceMappingURL` comments removed). OpenRig is licensed
under the Apache License 2.0 (https://github.com/mvschwarz/openrig). `test/openrig-remove-exited-session.test.js`
applies the 0.6.3 patches that touch `tmux.js` (135, 139, 142, 143) to a copy and drives `killSession` against a fake
tmux.
