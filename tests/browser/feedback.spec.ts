import { test, expect } from "@playwright/test";

// Covers the two user-visible findings from docs/honeybadger/PLAYTEST-2026-09-19.md:
// a rejected command whose reason was only reachable as a hover tooltip, and a
// short desktop window whose fixed-height command deck left an unusable
// battlefield. Both are feedback/layout fixes, so they are verified in a real
// browser rather than by unit test alone.

const database = process.env.STDB_DATABASE ?? "stdbrts-playtest";

test("a rejected command explains itself inline at a short desktop height", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  // The size the playtest called out: 240px of battlefield before the fix.
  await page.setViewportSize({ width: 990, height: 650 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(`/?database=${database}`);
  await expect(page.locator("#status")).toHaveText("Connected");
  await page.getByRole("button", { name: "Practice vs AI", exact: true }).click();
  await expect(page.locator("#match")).toBeVisible({ timeout: 20000 });

  // Finding 2: the battlefield must keep a workable share of a 650px window,
  // and the match view must not overflow the viewport as it did at 240px.
  const battlefield = (await page.locator("#battlefield").boundingBox())!;
  testInfo.annotations.push({ type: "battlefield-height", description: `${battlefield.height}px at 990x650` });
  expect(battlefield.height).toBeGreaterThan(280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

  // Every control the player needs mid-match survives the compaction.
  await expect(page.getByRole("button", { name: "Set rally destination", exact: true })).toBeVisible();
  await expect(page.locator("#minimap")).toBeVisible();
  await expect(page.locator("#command-list")).toBeVisible();

  // Finding 1: provoke a genuine rejection the way the playtest did. Both
  // cancels are accepted while the queue is non-empty; the first empties it on
  // activation, so the second fails its activation check a tick later.
  // Practice joins the room the bot created, so the human takes slot 1 and is
  // dealt Network: its labour unit is the drifter, at 40 material and 50 ticks,
  // and the worker button is not on this player's card at all.
  await page.getByRole("button", { name: "Drifter 40 material / 2.5s" }).click();
  await expect(page.locator("#command-list")).toContainText("train drifter");
  const cancel = page.getByRole("button", { name: "Cancel all unfinished production", exact: true });
  await cancel.click();
  await cancel.click();

  const reason = page.locator(".command-row.rejected .command-reason").first();
  await expect(reason).toBeVisible({ timeout: 20000 });
  await expect(reason).not.toBeEmpty();

  // The command list is rebuilt on a timer with replaceChildren. Resolving an
  // element handle and then evaluating against it races that rebuild: the node
  // is detached in between and every rect reads back as zero. So the query and
  // the measurement both happen inside one evaluate, retried until it observes
  // a row that is actually laid out.
  const row = await page.waitForFunction(() => {
    const node = document.querySelector(".command-row.rejected") as HTMLElement | null;
    const reasonNode = node?.querySelector(".command-reason") as HTMLElement | null;
    const labelNode = node?.querySelector(".command-label") as HTMLElement | null;
    if (!node || !reasonNode || !labelNode) return null;
    const rowRect = node.getBoundingClientRect();
    const reasonRect = reasonNode.getBoundingClientRect();
    const labelRect = labelNode.getBoundingClientRect();
    if (rowRect.width === 0 || reasonRect.width === 0) return null;
    return {
      title: node.title,
      text: reasonNode.textContent ?? "",
      reasonTop: reasonRect.top,
      reasonWidth: reasonRect.width,
      labelBottom: labelRect.bottom,
      rowWidth: rowRect.width,
    };
  }, undefined, { timeout: 20000 }).then(handle => handle.jsonValue());
  if (!row) throw new Error("no laid-out rejected command row appeared");

  // The reason is readable in the row itself, not only in the native tooltip.
  const reasonText = row.text.trim();
  testInfo.annotations.push({ type: "rejection-reason", description: reasonText });
  expect(reasonText.length).toBeGreaterThan(8);
  expect(row.title).toContain(reasonText);

  // It occupies its own full-width line rather than being squeezed onto the
  // label row, which is what makes it legible instead of clipped.
  expect(row.reasonTop).toBeGreaterThanOrEqual(row.labelBottom - 1);
  expect(row.reasonWidth).toBeGreaterThan(row.rowWidth * 0.9);

  // The history stays bounded: a wrapped reason scrolls inside the list instead
  // of growing the deck and stealing battlefield height back.
  const listBox = (await page.locator("#command-list").boundingBox())!;
  expect(listBox.height).toBeLessThanOrEqual(80);
  const after = (await page.locator("#battlefield").boundingBox())!;
  expect(after.height).toBe(battlefield.height);

  await page.screenshot({ path: testInfo.outputPath("short-height-rejection.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a tall desktop window is unchanged by the short-height rule", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?database=${database}`);
  await expect(page.locator("#status")).toHaveText("Connected");
  await page.getByRole("button", { name: "Practice vs AI", exact: true }).click();
  await expect(page.locator("#match")).toBeVisible({ timeout: 20000 });

  // 1000 - 64 masthead - 50 bar - 310 deck = 576, the height the playtest
  // recorded as comfortable. The max-height rule must not reach this window.
  const battlefield = (await page.locator("#battlefield").boundingBox())!;
  expect(battlefield.height).toBe(576);
  // The deck keeps its full-size minimap: the compact rule would shrink the
  // 164px declaration to 128px. It renders at 160px here because max-width
  // clamps it to the column, which is pre-existing and unrelated to the rule.
  expect(await page.locator("#minimap").evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(140);
});
