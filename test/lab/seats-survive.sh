#!/usr/bin/env bash
# Manual proof (needs a systemd user session): seats survive every daemon stop/restart path once the tmux server runs in
# its own unit. Uses ONLY throwaway units (lab-*) and a private tmux socket (-L lab-<pid>); never openrig.service, the
# default socket, or the real daemon (`rig` is a stub whose "daemon" is a tiny HTTP server on a free port).
#   test/lab/seats-survive.sh      prints PASS/FAIL per check; exit 1 on any FAIL
set -uo pipefail
S=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
id=$$; SOCK=lab-$id; TU=lab-tmux-$id; DU=lab-daemon-$id; work=$(mktemp -d "$HOME/.cache/seats-survive.XXXX")
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails + 1)); }
cleanup() { tmux -L $SOCK kill-server 2>/dev/null; systemctl --user stop $DU.service 2>/dev/null
  systemctl --user reset-failed $DU.service 2>/dev/null; [ -f "$work/home/daemon.json" ] && kill "$(jq -r .pid "$work/home/daemon.json")" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
panes() { tmux -L $SOCK list-panes -a -F '#{pane_pid}' 2>/dev/null | while read p; do kill -0 "$p" 2>/dev/null && echo "$p"; done | wc -l; }
server() { tmux -L $SOCK display -p '#{pid}' 2>/dev/null; }
partofs() { for s in $(systemctl --user list-units --type=scope --no-legend 'tmux-spawn-*' | awk '{print $1}'); do
  [[ "$(systemctl --user show "$s" -p Description --value)" == *"by process $(server)" ]] && systemctl --user show "$s" -p PartOf --value; done | sort -u; }

# 0. Baseline WITHOUT the fix, on a unit shaped like the old openrig.service (Type=oneshot, RemainAfterExit, KillMode=process,
#    ExecStop, tmux server started from ExecStart): documents what PartOf does on THIS systemd. Not relied on by the fix.
B=lab-oldshape-$id; BS=$SOCK-old
systemd-run --user --quiet --unit=$B -p Type=oneshot -p RemainAfterExit=yes -p KillMode=process -p ExecStop=/bin/true \
  sh -c "for s in a b; do tmux -L $BS has-session -t \$s 2>/dev/null || tmux -L $BS new-session -d -s \$s 'sleep infinity'; done"
sleep 1; bp() { tmux -L $BS list-panes -a -F '#{pane_pid}' 2>/dev/null | while read p; do kill -0 "$p" 2>/dev/null && echo "$p"; done | sort | tr '\n' ' '; }
before=$(bp); for i in 1 2 3; do systemctl --user restart $B.service; done; sleep 1.5
echo "INFO baseline (old shape, $(systemctl --version | head -1 | cut -d' ' -f1-2)): 3 restarts -> panes $([ "$(bp)" = "$before" ] && echo "unchanged" || echo "CHANGED ($before -> $(bp))"); result $(systemctl --user show $B.service -p Result --value)"
systemctl --user stop $B.service; sleep 1.5
echo "INFO baseline (old shape): stop -> panes $([ -z "$(bp)" ] && echo "ALL KILLED (the incident)" || echo "alive: $(bp)")"
tmux -L $BS kill-server 2>/dev/null; systemctl --user reset-failed $B.service 2>/dev/null

# the tmux unit, with openrig-tmux.service's semantics (condition, refuse manual stop, foreground server)
cond="if tmux -L $SOCK show -gv exit-empty >/dev/null 2>&1; then exit 1; fi"
systemd-run --user --quiet --unit=$TU --collect -p RefuseManualStop=yes -p "ExecCondition=/bin/sh -c '$cond'" tmux -L $SOCK -D
# the daemon unit, shaped like openrig.service (Type=oneshot, RemainAfterExit, KillMode=process, ExecStop), wants the
# tmux unit, and creates seats only as a tmux client
systemd-run --user --quiet --unit=$DU -p Type=oneshot -p RemainAfterExit=yes -p KillMode=process -p ExecStop=/bin/true \
  -p Wants=$TU.service -p After=$TU.service \
  sh -c "for s in seat-a seat-b; do tmux -L $SOCK has-session -t \$s 2>/dev/null || tmux -L $SOCK new-session -d -s \$s 'sleep infinity'; done"
sleep 1.5
[ "$(panes)" = 2 ] && ok "2 seats running" || bad "seats not started ($(panes))"
[ "$(partofs)" = "$TU.service" ] && ok "pane scopes are PartOf=$TU.service (not the daemon unit)" || bad "pane PartOf: $(partofs)"
for i in 1 2 3; do systemctl --user restart $DU.service; done; sleep 1.5
[ "$(panes)" = 2 ] && [ "$(systemctl --user show $DU.service -p Result --value)" = success ] && ok "daemon unit restart x3: seats alive" || bad "restart killed seats or failed"
systemctl --user stop $DU.service; sleep 1.5; [ "$(panes)" = 2 ] && ok "daemon unit STOP: seats alive" || bad "stop killed seats"
systemd-run --user --quiet --unit=$TU-second --collect -p "ExecCondition=/bin/sh -c '$cond'" tmux -L $SOCK -D 2>/dev/null; sleep 1
[ "$(systemctl --user show $TU-second.service -p Result --value 2>/dev/null)" != "exit-code" ] && [ "$(panes)" = 2 ] && ok "a second tmux unit skips an existing server" || bad "second tmux unit disturbed the server"
systemctl --user stop $TU.service >/dev/null 2>&1; [ "$(panes)" = 2 ] && ok "manual stop of the tmux unit is refused" || bad "tmux unit stopped"

# health path: the real openrig-daemon-cycle with a stub rig (stop/start a tiny HTTP "daemon", daemon.json like OpenRig's)
mkdir -p "$work/bin" "$work/home"
cat > "$work/bin/rig" <<STUB
#!/usr/bin/env bash
st=$work/home/daemon.json
case "\$1 \$2" in
  "daemon stop") [ -f \$st ] && kill \$(jq -r .pid \$st) 2>/dev/null; exit 0 ;;
  "daemon start") port=\$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
    setsid python3 -c 'import http.server,sys;h=type("H",(http.server.BaseHTTPRequestHandler,),{"do_GET":lambda s:(s.send_response(200),s.end_headers()),"log_message":lambda *a:None});http.server.HTTPServer(("127.0.0.1",int(sys.argv[1])),h).serve_forever()' \$port >/dev/null 2>&1 &
    printf '{"pid":%s,"port":%s}' \$! \$port > \$st; sleep 0.5; exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$work/bin/rig"
PATH="$work/bin:$PATH" OPENRIG_HOME=$work/home "$S/bin/openrig-daemon-cycle" --start-only --reason lab >/dev/null
old=$(jq -r .pid "$work/home/daemon.json" 2>/dev/null)
[ -n "$old" ] || { bad "stub daemon did not start; skipping the cycle so nothing can reach the real daemon"; exit 1; }
PATH="$work/bin:$PATH" OPENRIG_HOME=$work/home OPENRIG_CYCLE_WAIT=10 "$S/bin/openrig-daemon-cycle" --reason "health restart (lab)" > "$work/cycle.log"; rc=$?
new=$(jq -r .pid "$work/home/daemon.json")
[ $rc = 0 ] && [ "$old" != "$new" ] && ! kill -0 "$old" 2>/dev/null && ok "health path (openrig-daemon-cycle): old daemon gone, new one answering" || { bad "daemon cycle rc=$rc"; cat "$work/cycle.log"; }
[[ "$(cut -d: -f3 /proc/$new/cgroup)" == */openrig-daemon-*.scope ]] && ok "new daemon runs in its own scope" || bad "daemon cgroup $(cut -d: -f3 /proc/$new/cgroup)"
[ "$(panes)" = 2 ] && ok "health path: seats alive" || bad "health path killed seats"
tmux -L $SOCK kill-server; sleep 1
echo "-- $([ $fails = 0 ] && echo ALL PASS || echo "$fails FAIL")"; exit $((fails > 0))
