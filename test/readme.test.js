// README (WO30): every command in its examples is real. Blocks marked "Runs as shown" run here, in order, in a throwaway
// HOME (the clone URL points at this checkout; the password prompt gets a fake value). Blocks marked "Illustrative"
// need accounts or a running team: each command in them must exist, and each --flag must be one that command accepts.
// The README must also read plainly (no em dashes or AI vocabulary), link only to files that exist, and carry no
// personal data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(join(repo, "README.md"), "utf8");
const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const RUNS = "# Runs as shown", ILLUSTRATIVE = "# Illustrative";
const has = (cmd) => spawnSync("bash", ["-c", `command -v ${cmd}`]).status === 0;

test("every bash block says whether it runs as shown or is illustrative", () => {
  assert.ok(blocks.length >= 8);
  for (const b of blocks) assert.ok(b.startsWith(RUNS) || b.startsWith(ILLUSTRATIVE), b.split("\n")[0]);
});

// Split a line into commands (| && ;) and words, keeping quoted strings whole.
const commands = (line) => {
  const DQ = String.raw`"(?:[^"\\]|\\.)*"`;   // a double-quoted string, escapes allowed
  const re = new RegExp(String.raw`'[^']*'|${DQ}|\|\||&&|[|;]|[^\s|;&'"]+(?:'[^']*'|${DQ}|[^\s|;&'"]+)*`, "g");
  const toks = line.replace(/\s+#\s.*$/, "").match(re) || [];
  const out = [[]];
  for (const t of toks) (["|", "||", "&&", ";"].includes(t) ? out.push([]) : out[out.length - 1].push(t));
  return out.filter((c) => c.length);
};

// The commands on one line: $(...) substitutions count as commands of their own; subshell parens, `set`, variable
// assignments and `[ ... ]` tests are shell syntax, not commands to check.
function lineCommands(line) {
  line = line.replace(/\s+#\s.*$/, "");
  const subs = [];
  let out = "", i = 0;
  while (i < line.length) {
    if (line.startsWith("$(", i)) {
      let depth = 1, j = i + 2;
      while (j < line.length && depth) { if (line[j] === "(") depth++; else if (line[j] === ")") depth--; j++; }
      subs.push(line.slice(i + 2, j - 1)); out += "X"; i = j;
    } else out += line[i++];
  }
  let rest = out.trim().replace(/^(\w+=('[^']*'|"[^"]*"|\S+)\s*)+/, "");
  const own = !rest || ["(", ")"].includes(rest) || /^set\s/.test(rest) || rest.startsWith("[") ? [] : commands(rest);
  return [...own, ...subs.flatMap(lineCommands)];
}

// A block's logical lines: backslash continuations joined, and a single-quoted string that spans lines kept whole.
function logicalLines(block) {
  const out = []; let cur = "", heredoc = null;
  for (const raw of block.replace(/\\\n\s*/g, " ").split("\n")) {
    if (heredoc) { if (raw.trim() === heredoc) heredoc = null; continue; }   // a heredoc body is data, not commands
    const h = raw.match(/<<-?'?(\w+)'?/); if (h) heredoc = h[1];
    cur = cur ? `${cur} ${raw.trim()}` : raw;
    if (((cur.replace(/"(?:[^"\\]|\\.)*"/g, "").match(/'/g) || []).length % 2) === 0) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

test("illustrative blocks: every command exists and accepts every flag shown", () => {
  const help = (argv) => { const r = spawnSync(argv[0], [...argv.slice(1), "--help"], { encoding: "utf8", timeout: 30000 }); return (r.stdout || "") + (r.stderr || ""); };
  for (const b of blocks.filter((x) => x.startsWith(ILLUSTRATIVE))) {
    for (const line of logicalLines(b).filter((l) => l.trim() && !l.startsWith("#"))) {
      for (const words of lineCommands(line)) {
        const [cmd, ...rest] = words;
        const flags = rest.filter((w) => /^--[a-z]/.test(w)).map((w) => w.split("=")[0]);
        const local = ["bin", "system"].map((d) => join(repo, d, cmd)).find((p) => fs.existsSync(p))
          ?? (cmd === "./install.sh" ? join(repo, "install.sh") : cmd === "jev-decide" ? join(repo, "jev/bin/jev-decide.js") : null);
        if (local) {
          const src = fs.readFileSync(local, "utf8");
          for (const f of flags) assert.ok(src.includes(f), `${cmd} has no ${f} (${line})`);
        } else if (cmd === "rig" || cmd === "gh") {
          if (!has(cmd)) continue;   // not installed here: nothing to check against
          const subs = rest.slice(0, rest.findIndex((w) => !/^[a-z][a-z-]*$/.test(w)) >>> 0).slice(0, 2);
          const text = help([cmd, ...subs]);
          assert.doesNotMatch(text, /unknown command|is not a .* command/i, `${cmd} ${subs.join(" ")}`);
          for (const f of flags) assert.ok(text.includes(f), `${cmd} ${subs.join(" ")} has no ${f}`);
        } else {
          assert.ok(["jq", "git", "cd", "echo", "python3", "tmux", "cp"].includes(cmd), `unknown command in the README: ${cmd} (${line})`);
        }
      }
    }
  }
});

test("blocks that run as shown do what the README says, in a throwaway HOME", { timeout: 20 * 60 * 1000 }, () => {
  const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "readme-"));
  try {
    const env = { HOME: home, USER: process.env.USER || "user", PATH: `${join(repo, "bin")}:${process.env.PATH}` };
    const outs = [];
    for (const b of blocks.filter((x) => x.startsWith(RUNS))) {
      const script = b.replaceAll("https://github.com/korallis/agent-stack", repo);
      const r = spawnSync("bash", ["-c", script], { cwd: home, env, input: "fake-test-password\n", encoding: "utf8", timeout: 15 * 60 * 1000 });
      const out = (r.stdout || "") + (r.stderr || "");
      assert.doesNotMatch(out, /command not found|unknown option|Traceback|No such file or directory/i, `${b.split("\n")[1]}\n${out.slice(-800)}`);
      outs.push({ b, out, status: r.status });
    }
    const find = (s) => outs.find((o) => o.b.includes(s));
    assert.ok(fs.existsSync(join(home, "Projects/agent-stack/install.sh")), "the quick start clone");
    assert.equal(find("--name Demo ").status, 0); assert.match(find("--name Demo ").out, /would: /);
    assert.equal(find("--name StackDemo").status, 0); assert.match(find("--name StackDemo").out, /existing, trunk \S+: adopted as is/);
    assert.ok(!fs.existsSync(join(home, "Projects/Demo-work")) && !fs.existsSync(join(home, "Projects/StackDemo-work")), "dry runs create nothing");
    const pw = join(home, ".config/agent-stack/secrets/playwright.env");
    assert.equal(fs.statSync(pw).mode & 0o777, 0o600);
    const line = fs.readFileSync(pw, "utf8").trim();
    assert.equal(createHash("sha256").update(line).digest("hex"), createHash("sha256").update("MYAPP_ADMIN_PASSWORD=fake-test-password").digest("hex"));
    assert.doesNotMatch(find("read -rsp").out, /fake-test-password/, "the secret is never echoed");
    const machine = find("agent-credguard-check").out;
    assert.match(machine, /== Skills \(one line per source/); assert.match(machine, /ours \(skills\/ in this repo\)/);
    assert.match(machine, /seats guarded/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("README reads plainly, links to real files, and carries no personal data", () => {
  assert.doesNotMatch(readme, /—/, "no em dashes");
  for (const w of ["additionally", "crucial", "delve", "leverage", "utilize", "seamless", "robust", "pivotal", "showcase",
    "cutting-edge", "game-changer", "simply", "effortless", "in order to", "I hope this helps"])
    assert.doesNotMatch(readme, new RegExp(`\\b${w}\\b`, "i"), w);
  for (const [, target] of readme.matchAll(/\]\(([^)#]+)\)/g))
    if (!/^https?:/.test(target)) assert.ok(fs.existsSync(join(repo, target)), `broken link ${target}`);
  assert.doesNotMatch(readme, /\/home\/\w+|@(gmail|outlook|hotmail|icloud)\.|sk-[A-Za-z0-9]{10}/);
  for (const [, email] of readme.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)) assert.match(email, /@example\.invalid$/);
  // client and people names: test/anonymity.test.js checks the whole tree
  assert.match(readme, /```mermaid\nflowchart/, "a How it works diagram");
  assert.match(readme, /## Talk to your operator[\s\S]*> \*\*You:\*\* Onboard/, "example conversations");
  for (const h of ["What does it cost?", "Is it safe to run?", "What does it never do without me?"]) assert.ok(readme.includes(`### ${h}`), h);
});

test("agent-project-new on a machine with no git identity says so and stops (it used to exit 1 silently)", () => {
  const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "noid-"));
  try {
    const r = spawnSync(join(repo, "bin/agent-project-new"), ["--name", "Demo", "--rig", "demo", "--no-github", "--dry-run"],
      { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH, USER: "u" }, timeout: 60000 });
    assert.equal(r.status, 2); assert.match(r.stderr, /no commit identity\. Pass --identity/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test("the merge-gate example merges only when every gate passes (stub gh and jev-decide)", () => {
  const b = blocks.find((x) => x.includes("gh pr merge"));
  const dir = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "gate-"));
  try {
    const calls = join(dir, "calls");
    fs.mkdirSync(join(dir, "bin"));
    fs.writeFileSync(join(dir, "bin/gh"), `#!/bin/sh
echo "gh $*" >> "${calls}"
case "$1 $2" in
  "pr view") case "$*" in *headRefOid*) echo aaaa1111;; *) echo bbbb2222;; esac ;;
  "pr checks") exit "\${CHECKS_RC:-0}" ;;
  "api "*) echo "\${REVIEW_STATE:-success}" ;;
  "pr merge") echo merged ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(join(dir, "bin/jev-decide"), `#!/bin/sh
echo "jev $*" >> "${calls}"
[ "$2" = --input ] && { cat "$3" >> "${calls}"; echo >> "${calls}"; }
printf '{"decided_by":"%s","band":"%s","result":{"decision":"%s"}}\\n' "\${JEV_BY:-jev}" "\${JEV_BAND:-act}" "\${JEV_DECISION:-merge}"
`, { mode: 0o755 });
    const proofDir = join(dir, "work/missions/m01-accounts/slices/03-login/proof");
    fs.mkdirSync(proofDir, { recursive: true });
    const proof = (fm) => { fs.rmSync(proofDir, { recursive: true, force: true }); fs.mkdirSync(proofDir, { recursive: true });
      if (fm) fs.writeFileSync(join(proofDir, fm.name ?? "brb-aaaa1111.md"), `---\nslice: m01.03\ncandidate_sha: ${fm.sha ?? "aaaa1111"}\nartifact_type: ${fm.type ?? "qa"}\nverdict: ${fm.verdict ?? "PASS"}\nmoney_evidence: "Ship: YES, 5 criteria passed"\n---\n\nverdict: PASS\nartifact_type: qa\n`); };
    const run = (extra, fm = {}) => {
      fs.rmSync(calls, { force: true });
      proof(fm);
      const r = spawnSync("bash", ["-c", b], { cwd: dir, encoding: "utf8", env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, OPENRIG_WORK_ROOT: join(dir, "work"), ...extra } });
      const c = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
      return { status: r.status, merged: /gh pr merge/.test(c), calls: c };
    };
    const ok = run({});
    assert.equal(ok.status, 0, ok.calls); assert.ok(ok.merged);
    assert.match(ok.calls, /gh pr merge 42 --squash --match-head-commit aaaa1111/);
    assert.match(ok.calls, /gh pr checks 42 --required/);
    assert.match(ok.calls, /"head": "aaaa1111"/); assert.match(ok.calls, /"base": "bbbb2222"/);
    assert.match(ok.calls, /"review": "independent-review success; bug review board: Ship: YES, 5 criteria passed"/);
    assert.doesNotMatch(b, /ship YES/, "no QA verdict baked into the example");
    for (const [why, fm] of [["no QA proof", null], ["QA said NO", { verdict: "BLOCKING" }], ["QA proof for an older head", { sha: "0ld0ld00" }],
      ["QA proof under another head's name only", { name: "brb-0ld0ld00.md" }], ["not a qa artifact", { type: "guard" }],
      ["quoted but right", null]].slice(0, 5)) {
      const r = run({}, fm);
      assert.notEqual(r.status, 0, why); assert.ok(!r.merged, `${why}: merged anyway\n${r.calls}`);
    }
    const quoted = (() => { fs.rmSync(calls, { force: true }); proof({ sha: '"aaaa1111"' });
      const r = spawnSync("bash", ["-c", b], { cwd: dir, encoding: "utf8", env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, OPENRIG_WORK_ROOT: join(dir, "work") } });
      return /gh pr merge/.test(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""); })();
    assert.ok(quoted, "a YAML-quoted candidate_sha still matches");

    // The producer: a proof written by the real `rig proof add`, whose long money_evidence wraps over several YAML lines
    // (QA round 3). The whole evidence must reach Jev.
    if (has("rig")) {
      const long = "Ship: YES, all documented public command acceptance criteria passed, including repeat invocations, interrupted operations and invalid input; no open P0/P1 defects.";
      const sliceDir = join(dir, "work/missions/m01-accounts/slices/03-login");
      fs.writeFileSync(join(sliceDir, "SPEC.md"), "---\nid: m01.03\nstatus: building\n---\n# 03-login\n");
      fs.rmSync(proofDir, { recursive: true, force: true }); fs.writeFileSync(join(dir, "brb.md"), "Ship: YES\n");
      const add = spawnSync("rig", ["proof", "add", "m01-accounts/slices/03-login", "--artifact-type", "qa", "--verdict", "PASS",
        "--candidate-sha", "aaaa1111", "--money-evidence", long, "--file", "brb.md", "--name", "brb-aaaa1111.md"],
        { cwd: dir, encoding: "utf8", env: { ...process.env, OPENRIG_WORK_ROOT: join(dir, "work") } });
      const written = fs.readFileSync(join(proofDir, "brb-aaaa1111.md"), "utf8");
      assert.match(written, /money_evidence: "Ship: YES.*\n\s+\S/, `rig proof add wraps long evidence (exit ${add.status})`);
      fs.rmSync(calls, { force: true });
      const r = spawnSync("bash", ["-c", b], { cwd: dir, encoding: "utf8", env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, OPENRIG_WORK_ROOT: join(dir, "work") } });
      const c = fs.readFileSync(calls, "utf8");
      assert.equal(r.status, 0, r.stderr); assert.ok(c.includes(`bug review board: ${long}`), `the whole evidence reaches Jev:\n${c}`);
    }
    for (const [why, env] of [["a required check failed", { CHECKS_RC: "1" }], ["checks pending", { CHECKS_RC: "8" }],
      ["review failed", { REVIEW_STATE: "failure" }], ["no review status", { REVIEW_STATE: "null" }],
      ["Jev says hold", { JEV_DECISION: "hold", JEV_BAND: "uncertain" }], ["merge only in the review band", { JEV_BAND: "review" }],
      ["a fallback, not live Jev", { JEV_BY: "fallback_model" }], ["a cached answer", { JEV_BY: "cache" }]]) {
      const r = run(env);
      assert.notEqual(r.status, 0, why); assert.ok(!r.merged, `${why}: merged anyway\n${r.calls}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
