<!-- What changes and why (the incident or request behind it). -->

## Live behaviour on merge + pull
<!-- bin/ tools are symlinked into the live checkout, so a merged change to them is live as soon as it is pulled;
     units, seat-tools and root files wait for install.sh --apply or an install command. -->
- Does merging plus pulling change live behaviour before an install step? If so: how it is gated, or the exact
  install order.

## Tests
<!-- What proves it, and the mutation controls that fail without the change. -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
