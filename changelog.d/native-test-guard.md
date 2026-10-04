### Security
- Native seats (grok, kimi) get the test guard too: their CLIs run no PreToolUse hook of ours, so `agent-native-seat`
  puts `system/native-test-guard/bin` first on the CLI's PATH. node, npm, npx, pnpm, yarn, bun, python, pytest, vitest,
  jest, mocha, go, cargo and deno refuse a test run outside agent-heavy with the hook's message
  (`credguard-read-hook --test-argv` decides) and otherwise run the real program. The hook's and CULTURE's sandbox
  wording now matches the sandbox (only the repo and the seat's cache dir writable, a private /tmp).
