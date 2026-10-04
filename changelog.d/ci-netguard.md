### Security
- Local CI runners: a network guard. Jobs ran sandboxed but on the host's network, so a job could reach the host's
  own services (the OpenRig daemon, the model proxy, anything on 0.0.0.0) and the LAN and tailnet. Runners now run in
  `agent-heavy-ci.slice`, and one root nftables table (`system/ci-netguard`, installed once by
  `agent-ci-runner netguard-install`) refuses every local delivery from that slice except to the job's own listeners
  and the loopback resolver, and rejects private, tailnet and link-local ranges. Internet egress is unchanged.
  `register` probes the guard before every registration and fails closed (no runner, `CI_LOCAL` cleared).
  `agent-ci-runner netguard-check` runs the same probe.
