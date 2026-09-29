// WO5: seats never depend on openrig.service. Stub-only tests (no live units, daemon or tmux server):
// openrig-daemon-cycle, openrig-healthcheck, openrig-tmux-adopt, the unit files, and no script/doc stops/restarts
// openrig.service. The end-to-end proof on throwaway units is test/lab/seats-survive.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "seats-"));
const daemons = []; // fake daemons (double-forked sleeps), killed at exit
process.on("exit", () => {
  for (const p of daemons) try { process.kill(p); } catch {}
  for (const d of fs.readdirSync(root).filter(d => d.startsWith("cycle-"))) try { process.kill(JSON.parse(fs.readFileSync(join(root, d, "home/daemon.json"))).pid); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };
const stub = (dir, name, body) => write(join(dir, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$CALLS"\n${body}\n`, 0o755);
const calls = dir => (fs.existsSync(join(dir, "calls")) ? fs.readFileSync(join(dir, "calls"), "utf8") : "");
// Not a child of this (blocked) process: a killed direct child would stay a zombie that `kill -0` still sees.
const sleeper = () => { const pid = Number(spawnSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout); daemons.push(pid); return pid; };
const running = pid => { try { process.kill(pid, 0); return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); } catch { return false; } };

// ---- openrig-daemon-cycle ------------------------------------------------------------------------------
// Fakes: `rig daemon stop` kills the daemon.json pid and closes the listener unless stopFails; ss reports a listener
// owned by the pid in $dir/owner while $dir/up exists; curl answers 200 unless $dir/http-error;
// systemd-run --scope runs its command (so the stub `rig daemon start` really runs) and records its args.
function cycleWorld({ stopFails = false, startFails = false, startNoState = false, startWrongOwner = false } = {}) {
  const dir = fs.mkdtempSync(join(root, "cycle-")), bin = join(dir, "bin"), home = join(dir, "home");
  const daemon = sleeper();
  write(join(home, "daemon.json"), JSON.stringify({ pid: daemon, port: 7999 }));
  fs.writeFileSync(join(dir, "up"), ""); fs.writeFileSync(join(dir, "owner"), String(daemon));
  stub(bin, "rig", `case "$1 $2" in
  "daemon stop") ${stopFails ? ":" : `kill $(jq -r .pid "$OPENRIG_HOME/daemon.json"); rm -f "${dir}/up"`} ;;
  "daemon start") ${startFails ? ":" : startNoState ? `rm -f "$OPENRIG_HOME/daemon.json"; touch "${dir}/up"` :
    `sleep 300 >/dev/null 2>&1 & p=$!; printf '{"pid":%s,"port":7999}' $p > "$OPENRIG_HOME/daemon.json"; touch "${dir}/up"; echo ${startWrongOwner ? "1" : "$p"} > "${dir}/owner"`} ;;
esac; exit 0`);
  stub(bin, "curl", `[ -f "${dir}/up" ] && [ ! -f "${dir}/http-error" ]`);
  stub(bin, "ss", `[ -f "${dir}/up" ] && echo "LISTEN 0 511 127.0.0.1:7999 0.0.0.0:* users:((\\"node\\",pid=$(cat "${dir}/owner"),fd=3))"; exit 0`);
  stub(bin, "systemd-run", `while [ "\${1#-}" != "$1" ]; do shift; done; exec "$@"`);
  stub(bin, "systemctl", `[ "$*" = "--user show openrig.service -p Environment --value" ] && echo "OPENRIG_YOLO=1 PATH=${bin}:/usr/bin:/bin SHELL=/bin/bash"; exit 0`);
  stub(bin, "logger", "exit 0");
  return { dir, bin, home, daemon };
}
const cycle = (w, ...args) => spawnSync(join(repo, "bin/openrig-daemon-cycle"), args, { encoding: "utf8",
  env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.dir, OPENRIG_HOME: w.home, OPENRIG_CYCLE_WAIT: "2", CALLS: join(w.dir, "calls") } });

test("daemon-cycle: verified stop, start in its own scope with openrig.service's environment, never systemctl stop/restart", () => {
  const w = cycleWorld();
  const r = cycle(w, "--reason", "t");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w.dir);
  assert.match(c, /^rig daemon stop$/m);
  assert.match(c, /^systemd-run --user --scope --collect --quiet --unit=openrig-daemon-\d+ --description=OpenRig daemon \(openrig-daemon-cycle: t\) env OPENRIG_YOLO=1 PATH=\S+ SHELL=\/bin\/bash \/\S+\/rig daemon start$/m);
  assert.match(c, /^rig up kernel --existing$/m);
  assert.doesNotMatch(c, /systemctl --user (stop|restart|start)/);
  assert.notEqual(JSON.parse(fs.readFileSync(join(w.home, "daemon.json"))).pid, w.daemon);
  assert.equal(running(w.daemon), false, "the old daemon is gone");
});

test("daemon-cycle: if the old daemon is still there after stop, it neither signals it nor starts another (exit 1)", () => {
  const w = cycleWorld({ stopFails: true });
  const r = cycle(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STOP INCOMPLETE: pid \d+ still running port 7999 still has a listener \(pid \d+\)\. Not signalling it/);
  assert.doesNotMatch(calls(w.dir), /daemon start|systemd-run/);
  assert.equal(running(w.daemon), true, "the old daemon was not signalled");
});

test("daemon-cycle: a start with no new daemon behind the listener fails loudly (exit 1)", () => {
  const none = cycleWorld({ startFails: true });
  assert.equal(cycle(none).status, 1);
  // QA: /healthz answers but there is no daemon.json at all
  const noState = cycleWorld({ startNoState: true });
  const r = cycle(noState);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /START FAILED: no new running daemon owns the listener and answers \/healthz \(daemon\.json pid= port=/);
  // daemon.json names a running pid, but some other process owns the port
  const wrong = cycleWorld({ startWrongOwner: true });
  assert.equal(cycle(wrong).status, 1);
});

test("daemon-cycle: a stale pid is not 'stopped' while any listener remains, even one answering HTTP errors (exit 1)", () => {
  const w = cycleWorld();
  fs.writeFileSync(join(w.home, "daemon.json"), JSON.stringify({ pid: 999999, port: 7999 })); // stale: no such process
  fs.writeFileSync(join(w.dir, "owner"), "4242"); fs.writeFileSync(join(w.dir, "http-error"), ""); // a listener answering 503
  write(join(w.bin, "rig"), fs.readFileSync(join(w.bin, "rig"), "utf8").replace(/kill \$\(jq[^;]*;/, ":;").replace('rm -f "' + w.dir + '/up"', ":"));
  const r = cycle(w, "--stop-only");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STOP INCOMPLETE:  port 7999 still has a listener \(pid 4242\)\. Not signalling it/);
});

test("daemon-cycle: an ss failure fails closed on both stop and start (exit 1)", () => {
  for (const args of [["--stop-only"], ["--start-only"]]) {
    const w = cycleWorld();
    write(join(w.bin, "ss"), `#!/usr/bin/env bash\nprintf '%s\\n' "ss $*" >> "$CALLS"\nexit 1\n`, 0o755);
    const r = cycle(w, ...args);
    assert.equal(r.status, 1, `${args}: ${r.stdout}`);
    assert.match(r.stdout, /ss failed: listener (state unknown|unverified)/);
  }
});

// ---- openrig-healthcheck -------------------------------------------------------------------------------
function health({ healthy, cycleOk = true }) {
  const dir = fs.mkdtempSync(join(root, "health-")), bin = join(dir, ".local/bin");
  stub(bin, "curl", healthy ? "exit 0" : "exit 7");
  stub(bin, "openrig-daemon-cycle", cycleOk ? 'echo "openrig-daemon-cycle: running"' : 'echo "openrig-daemon-cycle: STOP INCOMPLETE: pid 1 still running"; exit 1');
  for (const t of ["systemctl", "notify-send", "logger", "sleep"]) stub(bin, t, "exit 0");
  const r = spawnSync(join(repo, "system/openrig-healthcheck"), [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, CALLS: join(dir, "calls") } });
  return { status: r.status, c: calls(dir) };
}

test("healthcheck: healthy does nothing; unhealthy cycles only the daemon; a failed cycle alerts; never systemctl", () => {
  const ok = health({ healthy: true });
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.c, /openrig-daemon-cycle/);
  const sick = health({ healthy: false });
  assert.equal(sick.status, 0);
  assert.match(sick.c, /^openrig-daemon-cycle --reason health check: healthz failed twice$/m);
  const stuck = health({ healthy: false, cycleOk: false });
  assert.equal(stuck.status, 1);
  assert.match(stuck.c, /^notify-send --app-name=Agent stack --urgency=critical OpenRig daemon down and not restarted openrig-daemon-cycle: STOP INCOMPLETE/m);
  for (const r of [ok, sick, stuck]) assert.doesNotMatch(r.c, /^systemctl/m);
});

// ---- openrig-tmux-adopt ---------------------------------------------------------------------------------
function adoptWorld() {
  const dir = fs.mkdtempSync(join(root, "adopt-")), bin = join(dir, "bin"), T = join(dir, "run/systemd/transient"), proc = join(dir, "proc");
  const unit = (id, spid, bound) => write(join(T, `tmux-spawn-${id}.scope`),
    `# transient\n[Unit]\nDescription=tmux child pane 10${id} launched by process ${spid}\n\n[Scope]\nSlice=app.slice\n\n[Unit]\nCollectMode=inactive-or-failed\n${bound ? "Before=openrig.service\nPartOf=openrig.service\n" : ""}`);
  unit("a", 500, true); unit("b", 500, true); unit("c", 777, true); // c belongs to another server: untouched
  write(join(proc, "500/cgroup"), "0::/user.slice/app.slice/openrig.service\n");
  stub(bin, "tmux", "echo 500");
  stub(bin, "busctl", `echo "0::/user.slice/app.slice/openrig-tmux.scope" > ${proc}/500/cgroup`);
  const live = join(dir, "live"); fs.mkdirSync(live);
  for (const u of ["a", "b", "c"]) fs.writeFileSync(join(live, `tmux-spawn-${u}.scope`), "openrig.service\n");
  stub(bin, "systemctl", `case "$2" in
  show) cat "${live}/$3" ;;
  daemon-reload) [ -f "${dir}/reload-fails" ] && exit 1
    for f in ${T}/tmux-spawn-*.scope; do (grep -h '^PartOf=' "$f" | cut -d= -f2) > "${live}/$(basename "$f")"; done ;;
esac; exit 0`);
  return { dir, bin, T, proc, live };
}
const adopt = (w, ...args) => spawnSync(join(repo, "bin/openrig-tmux-adopt"), args, { encoding: "utf8",
  env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.dir, OPENRIG_HOME: join(w.dir, "orhome"), XDG_RUNTIME_DIR: join(w.dir, "run"), AGENT_STACK_PROC: w.proc, CALLS: join(w.dir, "calls") } });

test("adopt: dry run changes nothing; --apply adopts the server, unbinds only its panes (backed up), reloads, verifies", () => {
  const w = adoptWorld();
  const before = fs.readFileSync(join(w.T, "tmux-spawn-a.scope"), "utf8");
  const dry = adopt(w);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /server pid 500 in openrig\.service; 2 pane scopes: 2 live PartOf=openrig\.service, 0 unreadable, 2 still bound on disk[\s\S]*dry run/);
  assert.equal(calls(w.dir).match(/^(busctl|systemctl --user daemon-reload)/m), null);
  const r = adopt(w, "--apply");
  assert.equal(r.status, 0, r.stdout);
  assert.match(calls(w.dir), /^busctl --user call .* StartTransientUnit ssa\(sv\)a\(sa\(sv\)\) openrig-tmux\.scope fail 3 PIDs au 1 500 RefuseManualStop b true /m);
  assert.match(calls(w.dir), /^systemctl --user daemon-reload$/m);
  for (const u of ["a", "b"]) assert.doesNotMatch(fs.readFileSync(join(w.T, `tmux-spawn-${u}.scope`), "utf8"), /openrig\.service/);
  assert.match(fs.readFileSync(join(w.T, "tmux-spawn-c.scope"), "utf8"), /PartOf=openrig\.service/, "other servers' panes untouched");
  const [bk] = fs.readdirSync(join(w.dir, "orhome/backups"));
  assert.equal(fs.readFileSync(join(w.dir, "orhome/backups", bk, "tmux-spawn-a.scope"), "utf8"), before);
  assert.match(r.stdout, /done: server pid 500 in openrig-tmux\.scope; 2 pane scopes: 0 live PartOf=openrig\.service, 0 unreadable, 0 still bound on disk/);
  assert.match(adopt(w).stdout, /already safe: nothing to do/);
  assert.doesNotMatch(calls(w.dir), /systemctl --user (stop|restart|kill)|^kill /m);
});

test("adopt: an unreadable live PartOf fails closed (exit 1), never 'done' or 'already safe'", () => {
  const w = adoptWorld();
  write(join(w.bin, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "systemctl $*" >> "$CALLS"\n[ "$2" = show ] && exit 1; exit 0\n`, 0o755);
  const r = adopt(w, "--apply");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /VERIFY FAILED: .* 2 unreadable.*Not safe yet\./);
  assert.doesNotMatch(r.stdout + adopt(w).stdout, /done:|already safe/);
});

test("adopt: after a failed daemon-reload the live dependency still decides; a re-run of --apply reloads and finishes", () => {
  const w = adoptWorld();
  fs.writeFileSync(join(w.dir, "reload-fails"), "");
  const first = adopt(w, "--apply");
  assert.equal(first.status, 1);
  assert.match(first.stdout, /daemon-reload failed; re-run --apply to retry/);
  const dry = adopt(w); // files are already edited and the server moved, but the manager still holds PartOf
  assert.doesNotMatch(dry.stdout, /already safe/);
  assert.match(dry.stdout, /2 live PartOf=openrig\.service, 0 unreadable, 0 still bound on disk[\s\S]*dry run/);
  fs.rmSync(join(w.dir, "reload-fails"));
  const retry = adopt(w, "--apply");
  assert.equal(retry.status, 0, retry.stdout);
  assert.match(retry.stdout, /done: .*0 live PartOf=openrig\.service, 0 unreadable/);
  assert.match(adopt(w).stdout, /already safe/);
});

// ---- units and the no-stop/restart rule ------------------------------------------------------------------
test("units: seats' tmux server has its own guarded unit with openrig.service's environment", () => {
  const tmux = fs.readFileSync(join(repo, "system/systemd/openrig-tmux.service"), "utf8");
  const daemon = fs.readFileSync(join(repo, "system/systemd/openrig.service"), "utf8");
  assert.match(tmux, /^RefuseManualStop=yes$/m);
  assert.match(tmux, /^ExecStart=\/usr\/bin\/tmux -D$/m);
  assert.match(tmux, /^ExecCondition=.*tmux show -gv exit-empty/m);
  const env = t => t.split("\n").filter(l => l.startsWith("Environment=")).sort();
  assert.deepEqual(env(tmux), env(daemon));
  assert.match(daemon, /^Wants=.*openrig-tmux\.service/m);
  assert.match(daemon, /^After=.*openrig-tmux\.service/m);
  assert.doesNotMatch(daemon, /BindsTo|Requires=.*openrig-tmux/);
});

test("no script or doc stops or restarts openrig.service", () => {
  const files = spawnSync("git", ["ls-files", "bin", "system", "docs", "skills", "rig", "README.md", "install.sh"], { cwd: repo, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const hits = files.filter(f => fs.statSync(join(repo, f)).isFile() && /systemctl --user (stop|restart) openrig(-tmux)?\.service/.test(fs.readFileSync(join(repo, f), "utf8")));
  assert.deepEqual(hits, []);
});
