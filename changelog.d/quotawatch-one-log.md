### Fixed
- `cliproxy-quotawatch` writes each alert to the journal once. Under systemd it wrote it twice, through `logger` and
  through stdout (which systemd also sends to the journal), so one run looked like two. It now prints to stdout only
  when run by hand (no `$JOURNAL_STREAM`). The desktop notification was always sent once.
