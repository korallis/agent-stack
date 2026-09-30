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
  const toks = line.replace(/\s+#\s.*$/, "").match(/'[^']*'|"[^"]*"|\|\||&&|[|;]|[^\s|;&'"]+(?:'[^']*'|"[^"]*"|[^\s|;&'"]+)*/g) || [];
  const out = [[]];
  for (const t of toks) (["|", "||", "&&", ";"].includes(t) ? out.push([]) : out[out.length - 1].push(t));
  return out.filter((c) => c.length);
};

test("illustrative blocks: every command exists and accepts every flag shown", () => {
  const help = (argv) => { const r = spawnSync(argv[0], [...argv.slice(1), "--help"], { encoding: "utf8", timeout: 30000 }); return (r.stdout || "") + (r.stderr || ""); };
  for (const b of blocks.filter((x) => x.startsWith(ILLUSTRATIVE))) {
    for (const line of b.split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
      for (const words of commands(line)) {
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
          assert.ok(["jq", "git", "cd", "echo"].includes(cmd), `unknown command in the README: ${cmd} (${line})`);
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
    assert.equal(find("--name StackDemo").status, 0); assert.match(find("--name StackDemo").out, /existing, trunk main: adopted as is/);
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
});

test("agent-project-new on a machine with no git identity says so and stops (it used to exit 1 silently)", () => {
  const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "noid-"));
  try {
    const r = spawnSync(join(repo, "bin/agent-project-new"), ["--name", "Demo", "--rig", "demo", "--no-github", "--dry-run"],
      { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH, USER: "u" }, timeout: 60000 });
    assert.equal(r.status, 2); assert.match(r.stderr, /no commit identity\. Pass --identity/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
