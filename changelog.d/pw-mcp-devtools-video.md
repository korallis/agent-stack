### Fixed
- Witness videos: `agent-playwright-mcp` enables the Playwright MCP's `devtools` capability, keeping any `--caps`
  already given. The pinned @playwright/mcp 0.0.80 only offers `browser_start_video` / `browser_stop_video` with it, so
  witnesses reported that "the MCP can't record video". The template's `coordination.md` and the witness-slice SPEC give
  the recipe: start a video at the start of the walk, stop it at the end, then `agent-video-fit`. Seats get the tools
  at their next relaunch.
