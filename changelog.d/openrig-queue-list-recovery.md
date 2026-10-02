### Fixed
- OpenRig patch 148: a queue list no longer scans every row's tags once per returned row to find its recovery
  disposition. The lookup is built once per list call with the original query's match and order, so responses are
  byte-identical (checked on a backup copy of the live queue: 17 queries, 53 MB of JSON) and the default list went from
  611 ms to 98 ms (213 active rows: 1270 to 117 ms).
