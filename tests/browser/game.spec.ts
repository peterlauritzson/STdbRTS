import { test, expect, type Page } from "@playwright/test";

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function canvasColors(page: Page): Promise<number> {
  return page.locator("#battlefield").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 124) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    return colors.size;
  });
}

test("desktop and touch multiplayer flow", async ({ browser }, testInfo) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await desktop.newPage();
  const peer = await mobile.newPage();
  const errors: string[] = [];
  host.on("pageerror", error => errors.push(error.message));
  peer.on("pageerror", error => errors.push(error.message));
  const database = process.env.STDB_DATABASE ?? "stdbrts-v2-dev";
  const roomName = `Browser ${Date.now()}`;
  try {
    await host.goto(`/?database=${database}`);
    await peer.goto(`/?database=${database}`);
    await expect(host.locator("#status")).toHaveText("Connected");
    await expect(peer.locator("#status")).toHaveText("Connected");
    await noOverflow(host);
    await noOverflow(peer);
    await peer.setViewportSize({ width: 320, height: 740 });
    await noOverflow(peer);
    await peer.setViewportSize({ width: 390, height: 844 });
    await peer.screenshot({ path: testInfo.outputPath("mobile-lobby.png"), fullPage: true });
    await host.getByLabel("Callsign").fill("North / Commander");
    await host.getByLabel("Room Name").fill(roomName);
    await host.getByRole("button", { name: "Create Room", exact: true }).click();
    await expect(host.locator("#waiting-name")).toHaveText(roomName);
    await peer.getByLabel("Callsign").fill("South / Commander");
    await peer.locator(".room-row").filter({ hasText: roomName }).getByRole("button", { name: "Join", exact: true }).click();
    await expect(host.locator("#roster .roster-row")).toHaveCount(2);
    await host.getByLabel("Ready", { exact: true }).check();
    await peer.getByLabel("Ready", { exact: true }).check();
    await host.getByRole("button", { name: "Deploy", exact: true }).click();
    await expect(host.locator("#match")).toBeVisible();
    await expect(peer.locator("#match")).toBeVisible();
    await expect.poll(() => canvasColors(host)).toBeGreaterThan(20);
    await expect.poll(() => canvasColors(peer)).toBeGreaterThan(20);
    await noOverflow(host);
    await noOverflow(peer);
    await host.setViewportSize({ width: 1920, height: 1080 });
    await noOverflow(host);
    await host.setViewportSize({ width: 1440, height: 1000 });
    await peer.setViewportSize({ width: 320, height: 740 });
    await noOverflow(peer);
    await peer.setViewportSize({ width: 390, height: 844 });
    await host.getByRole("button", { name: "Worker 50 ore / 3s" }).click();
    await expect(host.locator("#command-list")).toContainText("train worker");
    await expect(host.locator("#resources")).toHaveText("200");
    await expect(host.locator("#unit-count")).toHaveText("4 / 60");
    await host.getByRole("button", { name: "Select army", exact: true }).click();
    await expect(host.locator("#selection-title")).toHaveText("Soldier");
    const canvas = host.locator("#battlefield");
    const before = await canvas.screenshot();
    await canvas.click({ position: { x: 520, y: 280 }, button: "right" });
    await expect(host.locator("#command-list")).toContainText("move / 1");
    await expect.poll(async () => host.locator("#pending-count").innerText()).toBe("0");
    const after = await canvas.screenshot();
    expect(before.equals(after)).toBe(false);
    await host.screenshot({ path: testInfo.outputPath("desktop-match.png") });
    await host.reload();
    await expect(host.locator("#status")).toHaveText("Connected");
    await expect(host.locator("#match")).toBeVisible();
    await expect(host.locator("#resources")).toHaveText("200");
    await expect(host.locator("#unit-count")).toHaveText("4 / 60");
    await peer.getByRole("button", { name: "Select army", exact: true }).click();
    await peer.getByRole("radio", { name: "Order", exact: true }).check();
    await peer.locator("#battlefield").scrollIntoViewIfNeeded();
    const bounds = await peer.locator("#battlefield").boundingBox();
    await peer.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(peer.locator("#command-list")).toContainText("move / 1");
    await noOverflow(peer);
    await peer.screenshot({ path: testInfo.outputPath("mobile-match.png"), fullPage: true });
    await peer.getByRole("button", { name: "Surrender and leave", exact: true }).click();
    await peer.getByRole("button", { name: "Surrender", exact: true }).click();
    await expect(peer.locator("#lobby")).toBeVisible();
    await expect(host.locator("#result-title")).toHaveText("Victory");
    await host.getByRole("button", { name: "Surrender and leave", exact: true }).click();
    await expect(host.locator("#lobby")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
    await mobile.close();
  }
});