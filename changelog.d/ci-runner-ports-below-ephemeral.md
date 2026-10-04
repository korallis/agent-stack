### Fixed
- Local CI runners: job `E2E_PORT`s move to 31000..31099, below the kernel's ephemeral range (32768..60999) and clear
  of the seats' 20000..29999. In the old 471xx range any outgoing connection could hold a runner's port as its local
  end, and a job's test server then failed with EADDRINUSE. Old allocations move at each runner's next registration,
  and a range overlapping the ephemeral ports is refused.
