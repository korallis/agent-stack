# Playwright MCP --secrets: evidence against the pinned @playwright/mcp@0.0.80 (2026-09-30)

Real stdio MCP sessions (throwaway HOME, local page with a password field), from `playwright-secrets-evidence.mjs`:

```

=== WITHOUT --secrets (today)
  agent SENDS browser_type: {"element":"Password","target":"e6","text":"S3cretXYZ"}
  browser_type RETURNS:
    await page.getByRole('textbox', { name: 'Password' }).fill('S3cretXYZ');
  next browser_snapshot RETURNS:
        - text: Password
        - textbox "Password" [active] [ref=e6]: S3cretXYZ
  page's password length (browser_evaluate): 9
  literal value "S3cretXYZ" appears in ANY response: true

=== WITH --secrets <throwaway HOME>/playwright.env
  agent SENDS browser_type: {"element":"Password","target":"e6","text":"WITNESS_PASSWORD"}
  browser_type RETURNS:
    await page.getByRole('textbox', { name: 'Password' }).fill(process.env['WITNESS_PASSWORD']);
  next browser_snapshot RETURNS:
        - text: Password
        - textbox "Password" [active] [ref=e6]: <secret>WITNESS_PASSWORD</secret>
  page's password length (browser_evaluate): 9
  literal value "S3cretXYZ" appears in ANY response: false
```
