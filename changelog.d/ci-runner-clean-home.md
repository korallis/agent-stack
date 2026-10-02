### Security
- Local CI runners: nothing a job writes reaches the next job. Before every job the runner is re-extracted from the
  checksum-verified release, and its home and tool cache are wiped (`AGENT_CI_KEEP_CACHE=1` keeps those two). A job
  could write its whole runner directory, so a same-repo PR job could otherwise have left a tampered runner, `.npmrc`
  or cached tool for a later main build (found in a project's review of its workflow change).
