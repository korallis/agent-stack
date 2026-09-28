# Acceptance journeys (locked)

Each folder `tests/acceptance/<feature-id>/` holds browser journeys that prove the feature works **for a person using the app**.
They are written by the test-author seat before the feature is built, and only a `tests/*` branch may change them (CI enforces this).

A journey does what a person does, and nothing else:

```ts
import { test, expect } from '@playwright/test';

test('a candidate books the first available date', async ({ page }) => {
  await page.goto('/book/demo-link');
  await expect(page.getByRole('heading', { name: 'Choose a date' })).toBeVisible();
  await page.getByRole('button', { name: /Mon 12 Oct/ }).click();
  await page.getByLabel('Email').fill('sam@example.com');
  await page.getByRole('button', { name: 'Book place' }).click();
  await expect(page.getByText('You are booked')).toBeVisible();
});
```

Allowed: `page.goto`, `getByRole` / `getByLabel` / `getByText` / `getByPlaceholder` / `getByAltText` / `getByTitle`,
clicking, typing, keyboard, going back and forward, and `expect` on what is visible.

Not allowed (checked by `scripts/guards/check-human-perspective.sh`): running code in the page, mocking the network,
calling APIs or the database, injecting cookies or storage, CSS/XPath/test-id selectors, importing app code,
skipped or focused tests, fixed sleeps.

Setup a person cannot do (seeding a training programme, creating test accounts) goes in `fixtures/` with a comment
explaining it. A shared login done through the real sign-in page may save browser state there for reuse.

Every journey runs twice: on a desktop browser and on a phone-sized screen.
