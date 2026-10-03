### Fixed
- `agent-ci-runner install` no longer re-extracts a runner that is already installed. Scaling a repo up (`--count`) while a
  runner was mid-job would have pulled that job's files from under it. Registration still re-extracts the verified release
  before every start.
