### Fixed
- `install.sh` applies local OpenRig patches added for the version already installed. Before, `openrig-ensure`
  applied patches only on a version change (through `openrig-upgrade`), so a new patch such as 143 showed "NOT
  applied" in the check and needed a manual `openrig-apply-patches`. When it applies one, it notes that the daemon
  loads it at its next start (`openrig-daemon-cycle`). It never restarts the daemon itself.
