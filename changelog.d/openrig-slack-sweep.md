### Fixed
- OpenRig patch 147: the Slack outbound sweep (every 30 s) no longer builds every active queue row's full face to find
  the few with an unposted owner notification. It reads active ids, checks notification and receipt first, and loads a
  full row only for an alert it will post: the same alerts in the same order. On a copy of the live queue (213 active
  rows) the sweep went from 1.4-2.1 s of blocked event loop to 8-18 ms.
