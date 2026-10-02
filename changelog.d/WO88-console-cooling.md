### Changed
- `rig-console`: a cooling account says what its timers mean, from the proxy's cooldowns (`scope`, `retry_at`,
  `reason`). A credential-wide cooldown gates the whole account and wins over model timers ("cooling until Sun 07:00Z
  (quota, whole account, in 2d)"); model timers say when the first model is back ("3 models cooling, first back Sun
  07:00Z (quota, in 2d)"); a disabled account is never promised back. The Pool lists each cooling account under the
  rows, and Home's account panel names the next one back in its title.
