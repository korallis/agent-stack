### Fixed
- Local CI runners: tools that write under the home directory work. The runner's worker sets `HOME` from the user
  database, so jobs saw the real home path, which is a read-only empty tmpfs in the sandbox; Playwright's browser install
  failed with `mkdir ~/.cache: ENOENT`. The runner's own home dir is now mounted over that path, still wiped every job and
  still hiding the agents' files.
