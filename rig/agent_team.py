#!/usr/bin/env python3
"""agent-team — generate, launch and resize the balanced 12 Claude + 12 Codex OpenRig team for a repo.

  agent-team init   <repo> [--pilot]     create .agent-team/, per-seat worktrees, rendered RigSpec
  agent-team up     <repo> [--pilot]     init (idempotent) + validate + `rig up`
  agent-team grow   <repo> <seat...>     add seats from the full roster to a running rig
  agent-team shrink <repo> <seat...>     remove seats (worktrees with uncommitted work are kept)
  agent-team roster                      print the full roster

Design notes
- Every seat gets its OWN cwd (a git worktree) — avoids OpenRig managed-block collisions (#64) and
  lets implementers work concurrently on branches agent/<seat>. The Claude integrator works in the
  main checkout and is the only seat that merges into the default branch.
- Proxy routing / Jev access are NOT in the spec: seats inherit them from ~/.config/agent-stack/env.sh
  (Claude, keyed on OPENRIG_NODE_ID) and ~/.codex/config.toml (Codex), so launch and restart behave
  identically. YOLO comes from permission_policy: builtin:yolo (the only honoured mechanism in 0.5.x).
"""
import os, re, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENTS = HERE / "agents"
CULTURE = HERE / "templates" / "CULTURE.md"
CLAUDE_MODEL = "claude-opus-5-5"
CODEX_MODEL = "gpt-6-astra"

# (pod, member, runtime, role, branch_mode)  branch_mode: own = agent/<seat> branch, main = repo root,
# detached = read-mostly worktree at the default branch tip.
ROSTER = [
    ("coord", "lead-claude", "claude-code", "lead", "detached"),
    ("coord", "deputy-codex", "codex", "deputy", "detached"),
    ("arch", "claude", "claude-code", "architect", "detached"),
    ("arch", "codex", "codex", "architect", "detached"),
    *[("impl", f"claude-{i}", "claude-code", "implementer", "own") for i in range(1, 7)],
    *[("impl", f"codex-{i}", "codex", "implementer", "own") for i in range(1, 7)],
    *[("review", f"claude-{i}", "claude-code", "reviewer", "detached") for i in range(1, 4)],
    *[("review", f"codex-{i}", "codex", "reviewer", "detached") for i in range(1, 4)],
    ("integ", "claude", "claude-code", "integrator", "main"),
    ("integ", "codex", "codex", "integrator", "own"),
]
PILOT = {("coord", "lead-claude"), ("impl", "codex-1")}
POD_LABELS = {"coord": "Coordination", "arch": "Architecture & planning", "impl": "Implementation",
              "review": "Review & testing", "integ": "Integration & recovery"}


def sh(*cmd, cwd=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if check and r.returncode:
        sys.exit(f"command failed: {' '.join(cmd)}\n{r.stderr.strip()}")
    return r.stdout.strip()


def seat_id(pod, member):
    return f"{pod}-{member}"


def rig_name(repo: Path, pilot: bool):
    base = re.sub(r"[^a-z0-9-]+", "-", repo.name.lower()).strip("-") or "project"
    return f"{'pilot' if pilot else 'team'}-{base}"


def default_branch(repo):
    return sh("git", "symbolic-ref", "--short", "HEAD", cwd=repo)


def ensure_worktree(repo: Path, seat: str, mode: str):
    if mode == "main":
        return repo
    wt = repo / ".worktrees" / seat
    if wt.exists():
        return wt
    base = default_branch(repo)
    if mode == "own":
        branch = f"agent/{seat}"
        exists = subprocess.run(["git", "rev-parse", "--verify", "--quiet", branch], cwd=repo).returncode == 0
        args = [str(wt), branch] if exists else ["-b", branch, str(wt), base]
        sh("git", "worktree", "add", *args, cwd=repo)
    else:
        sh("git", "worktree", "add", "--detach", str(wt), base, cwd=repo)
    return wt


def render(text, ctx):
    for k, v in ctx.items():
        text = text.replace("{{" + k + "}}", v)
    return text


def init(repo: Path, pilot: bool):
    repo = repo.resolve()
    if not (repo / ".git").exists():
        sys.exit(f"{repo} is not a git repository root")
    if not sh("git", "rev-parse", "--verify", "--quiet", "HEAD", cwd=repo, check=False):
        sys.exit("repository needs at least one commit (worktrees branch from it)")
    team = repo / ".agent-team"
    for d in ("rig", "handoffs", "plans", "incidents", "state"):
        (team / d).mkdir(parents=True, exist_ok=True)
    for f, body in (("REQUIREMENTS.md", "# Requirements\n\nOne section per queue item / feature. Owner keeps it current.\n"),
                    ("DECISIONS.md", "# Decisions\n\nDate — decision — why — who.\n")):
        if not (team / f).exists():
            (team / f).write_text(body)
    # keep team state + worktrees out of the project's history
    exclude = repo / ".git" / "info" / "exclude"
    ex = exclude.read_text() if exclude.exists() else ""
    add = [p for p in ("/.agent-team/", "/.worktrees/", "CLAUDE.local.md") if p not in ex]
    if add:
        exclude.write_text(ex.rstrip("\n") + "\n# agent-team\n" + "\n".join(add) + "\n")

    ctx = {"PROJECT": repo.name, "REPO": str(repo), "TEAM_DIR": str(team)}
    rig_root = team / "rig"
    # Render agent specs into the rig root (guidance gets absolute team paths).
    if (rig_root / "agents").exists():
        shutil.rmtree(rig_root / "agents")
    shutil.copytree(AGENTS, rig_root / "agents", symlinks=True)
    for g in (rig_root / "agents").glob("*/guidance/*.md"):
        g.write_text(render(g.read_text(), ctx))
    shared = rig_root / "openrig-shared"
    if shared.is_symlink() or shared.exists():
        shared.unlink()
    shared.symlink_to((HERE / "openrig-shared").resolve())
    (rig_root / "CULTURE.md").write_text(render(CULTURE.read_text(), ctx))

    members_by_pod = {}
    for pod, member, runtime, role, mode in ROSTER:
        if pilot and (pod, member) not in PILOT:
            continue
        seat = seat_id(pod, member)
        cwd = ensure_worktree(repo, seat, mode)
        members_by_pod.setdefault(pod, []).append((member, runtime, role, cwd))

    name = rig_name(repo, pilot)
    lines = ['version: "0.2"', f"name: {name}",
             f"summary: \"Balanced Claude/Codex team for {repo.name} (generated by agent-team; edit the generator, not this file)\"",
             "culture_file: CULTURE.md",
             "permission_policy: builtin:yolo",
             "managed_blocks:", "  claude-code: CLAUDE.local.md", "", "pods:"]
    for pod, members in members_by_pod.items():
        lines += [f"  - id: {pod}", f"    label: \"{POD_LABELS[pod]}\"", "    members:"]
        for member, runtime, role, cwd in members:
            lines += [f"      - id: {member}",
                      f"        agent_ref: \"local:agents/{role}\"",
                      "        profile: default",
                      f"        runtime: {runtime}",
                      f"        model: {CLAUDE_MODEL if runtime == 'claude-code' else CODEX_MODEL}",
                      f"        role: {role}",
                      f"        cwd: \"{os.path.relpath(cwd, rig_root)}\"",
                      "        restore_policy: resume_if_possible"]
        lines.append("    edges: []")
    # Edges: lead delegates to everyone; deputy escalates to lead; reviewers observe implementers.
    present = {(p, m) for p, ms in members_by_pod.items() for m, *_ in ms}
    edges = []
    if ("coord", "lead-claude") in present:
        edges += [("delegates_to", ("coord", "lead-claude"), pm) for pm in sorted(present) if pm != ("coord", "lead-claude")]
        if ("coord", "deputy-codex") in present:
            edges.append(("escalates_to", ("coord", "deputy-codex"), ("coord", "lead-claude")))
    edges += [("can_observe", r, i) for r in sorted(present) if r[0] == "review" for i in sorted(present) if i[0] == "impl"]
    local = {}
    cross = []
    for kind, a, b in edges:
        (local.setdefault(a[0], []).append((kind, a[1], b[1])) if a[0] == b[0] else cross.append((kind, f"{a[0]}.{a[1]}", f"{b[0]}.{b[1]}")))
    out = []
    for ln in lines:
        out.append(ln)
    lines = []
    pod = None
    for ln in out:
        m = ln.strip()
        if ln.startswith("  - id: "):
            pod = ln.split("  - id: ", 1)[1]
        if ln == "    edges: []" and local.get(pod):
            lines.append("    edges:")
            for kind, a, b in local[pod]:
                lines += [f"      - kind: {kind}", f"        from: {a}", f"        to: {b}"]
            continue
        lines.append(ln)
    lines.append("")
    lines.append("edges:" + ("" if cross else " []"))
    for kind, a, b in cross:
        lines += [f"  - kind: {kind}", f"    from: {a}", f"    to: {b}"]
    spec = rig_root / f"{name}.yaml"
    spec.write_text("\n".join(lines) + "\n")
    print(spec)
    return spec


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(__doc__); return
    cmd = a[0]
    if cmd == "roster":
        for pod, member, runtime, role, mode in ROSTER:
            print(f"{seat_id(pod, member):<20} {runtime:<12} {role:<12} {mode}")
        return
    repo = Path(a[1]).resolve()
    pilot = "--pilot" in a
    if cmd == "init":
        init(repo, pilot)
    elif cmd == "up":
        spec = init(repo, pilot)
        for c in (["rig", "spec", "validate", str(spec)], ["rig", "spec", "preflight", str(spec)]):
            r = subprocess.run(c, text=True)
            if r.returncode:
                sys.exit(r.returncode)
        os.execvp("rig", ["rig", "up", str(spec)])
    elif cmd in ("grow", "shrink"):
        name = rig_name(repo, pilot)
        seats = [s for s in a[2:] if not s.startswith("--")]
        for s in seats:
            match = [r for r in ROSTER if seat_id(r[0], r[1]) == s]
            if not match:
                sys.exit(f"unknown seat {s}; see `agent-team roster`")
            pod, member, runtime, role, mode = match[0]
            if cmd == "grow":
                cwd = ensure_worktree(repo, s, mode)
                subprocess.run(["rig", "grow", name, member, "--pod", pod, "--runtime", runtime, "--cwd", str(cwd)], check=True)
            else:
                subprocess.run(["rig", "remove", name, f"{s}@{name}"], check=True)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
