### Fixed
- Local CI runners run jobs in UTC with the `C.UTF-8` locale (`TZ`, `LANG`, `LC_ALL` in the unit), the same as GitHub's
  hosted Ubuntu images. Date-sensitive browser tests ("last Monday", "this week") failed on the host's Europe/London time.
