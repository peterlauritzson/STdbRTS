import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

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

// World-to-screen must follow the map the client actually renders. This used to
// hardcode the 1600 map's extent and half-extent, which silently aimed every
// click at the wrong place once matches moved to a larger map.
const WORLD: number = JSON.parse(readFileSync(new URL("../../shared/maps/crossfire.json", import.meta.url), "utf8")).size;

async function worldClick(page: Page, x: number, y: number): Promise<void> {
  await page.getByRole("button", { name: "Show whole map", exact: true }).click();
  const bounds = await page.locator("#battlefield").boundingBox();
  const scale = Math.min(bounds!.width, bounds!.height) / WORLD * 0.97;
  await page.locator("#battlefield").click({ position: { x: bounds!.width / 2 + (x - WORLD / 2) * scale, y: bounds!.height / 2 + (y - WORLD / 2) * scale } });
}

/** The same aim, but the right button: an order rather than a selection. */
async function worldOrder(page: Page, x: number, y: number): Promise<void> {
  await page.getByRole("button", { name: "Show whole map", exact: true }).click();
  const bounds = await page.locator("#battlefield").boundingBox();
  const scale = Math.min(bounds!.width, bounds!.height) / WORLD * 0.97;
  await page.locator("#battlefield").click({ button: "right", position: { x: bounds!.width / 2 + (x - WORLD / 2) * scale, y: bounds!.height / 2 + (y - WORLD / 2) * scale } });
}

/**
 * `worldClick` for a touch device. Tapping the middle of the viewport aims at
 * whatever the camera happens to be centred on — which is usually the player's
 * own base, so an attack-move there finishes instantly and reads as "stop".
 * Aim in world space instead.
 */
async function worldTap(page: Page, x: number, y: number): Promise<void> {
  await page.getByRole("button", { name: "Show whole map", exact: true }).tap();
  const bounds = await page.locator("#battlefield").boundingBox();
  const scale = Math.min(bounds!.width, bounds!.height) / WORLD * 0.97;
  await page.touchscreen.tap(
    bounds!.x + bounds!.width / 2 + (x - WORLD / 2) * scale,
    bounds!.y + bounds!.height / 2 + (y - WORLD / 2) * scale,
  );
}

/**
 * A drag box in world space, selecting whatever owned, non-building units it
 * encloses. Labour now leaves spawn already gathering (the server assigns
 * each labourer to its nearest deposit the instant the match starts), so
 * there is no longer an idle worker for "Select idle worker" to find — a box
 * around the spawn point still finds it by position, regardless of what
 * order it is already carrying out.
 */
async function worldBoxSelect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await page.getByRole("button", { name: "Show whole map", exact: true }).click();
  const bounds = await page.locator("#battlefield").boundingBox();
  const scale = Math.min(bounds!.width, bounds!.height) / WORLD * 0.97;
  const toScreen = (x: number, y: number) => ({ x: bounds!.x + bounds!.width / 2 + (x - WORLD / 2) * scale, y: bounds!.y + bounds!.height / 2 + (y - WORLD / 2) * scale });
  const start = toScreen(x1, y1);
  const end = toScreen(x2, y2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

test("one-click practice, construction, scouts and persistent base management", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/?database=${process.env.STDB_DATABASE ?? "stdbrts-playtest"}`);
  await expect(page.locator("#status")).toHaveText("Connected");
  // Practice lets you pick a faction, and the picker opens on the one the
  // practice slot deals, so the button below is still a single click for a
  // player who does not care which economy they get.
  await expect(page.locator("#practice-faction")).toHaveValue("network");
  await page.getByRole("button", { name: "Practice vs AI", exact: true }).click();
  await expect(page.locator("#match")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#battle-players")).toContainText("Automaton");
  // The bot creates the practice room and the human joins it, so the human is
  // slot 1 and therefore Network unless they chose otherwise above. A player
  // sees their own labour unit and neither of the other two.
  await expect(page.locator("#faction-readout")).toContainText("NETWORK");
  await expect(page.getByRole("button", { name: "Drifter 40 material / 2.5s", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Worker/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Harvester/ })).toHaveCount(0);
  // Harvester stock is an Organic readout and means nothing here, so it is not
  // shown at all rather than shown as a permanent zero.
  await expect(page.locator("#stock-readout")).toBeHidden();
  // A practice match ends when one side's HQ falls, and walking an army across
  // a 3200-unit map to grind down 1200 HP of headquarters is far outside this
  // test's budget — so this test asserts the *live* half of the contract and
  // the multiplayer test below, where a concession really does finish a match,
  // asserts the score screen itself. While the room is playing, the result
  // element must stay the small banner it has always been: a live match is
  // never covered by a score screen.
  await expect(page.locator("#scoreboard")).toBeHidden();
  await expect(page.locator("#result")).not.toHaveClass(/final/);
  // Opponent factions are public: the bot took slot 0 and is Industrial.
  await expect(page.locator("#battle-players")).toContainText("Industrial");
  await expect(page.locator("#battle-players")).toContainText("Network");
  // The two currencies are reported separately and never summed: the opening
  // is 250 material and no catalyst at all.
  await expect(page.locator("#material-readout")).toContainText("MATERIAL");
  await expect(page.locator("#catalyst-readout")).toContainText("CATALYST");
  await expect(page.locator("#catalyst")).toHaveText("0");
  expect(Number(await page.locator("#material").innerText())).toBeGreaterThanOrEqual(250);
  // A two-currency cost is quoted in full, and the button says which currency
  // it is short of rather than simply going grey.
  const siege = page.getByRole("button", { name: "Siege 150 material + 50 catalyst / 8s", exact: true });
  await expect(siege).toBeDisabled();
  await expect(siege).toHaveAttribute("data-shortfall", "catalyst");
  await page.getByRole("tab", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Barracks 150 material / 8s", exact: true }).click();
  await expect(page.locator("#targeting-state")).toHaveText("Place Barracks");
  // Construction is driven by any labour unit: a Network player has drifters
  // and no workers, and used to find every build button permanently disabled.
  await worldClick(page, 2480, 680);
  await expect(page.locator("#command-list")).toContainText("build barracks");
  await expect(page.locator("#producer-select option").filter({ hasText: "Barracks" })).toHaveCount(1, { timeout: 25000 });
  await page.getByRole("tab", { name: "Production", exact: true }).click();
  const barracks = await page.locator("#producer-select option").filter({ hasText: "Barracks" }).getAttribute("value");
  await page.getByLabel("Production building", { exact: true }).selectOption(barracks!);
  await expect(page.locator("#selection-title")).toHaveText("Barracks");
  await page.getByRole("button", { name: "Scout 80 material / 3.5s", exact: true }).click();
  await expect(page.locator("#unit-count")).toHaveText("4 / 60", { timeout: 15000 });
  await page.getByRole("button", { name: "Set rally destination", exact: true }).click();
  await worldClick(page, 2484, 419);
  await expect(page.locator("#rally-status")).toContainText("Material rally");
  await page.getByRole("tab", { name: "Build", exact: true }).click();
  await expect(page.getByRole("button", { name: "Outpost 100 material / 6s", exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByRole("button", { name: "Outpost 100 material / 6s", exact: true }).click();
  await worldClick(page, 2600, 755);
  await expect(page.locator("#building-count")).toHaveText("3 / 16 structures");
  await worldClick(page, 2600, 755);
  await expect(page.locator("#selection-title")).toHaveText("Outpost");
  await page.getByRole("button", { name: "Cancel construction", exact: true }).click();
  await expect(page.locator("#building-count")).toHaveText("2 / 16 structures");
  await page.getByRole("button", { name: "Center on HQ", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("desktop-base.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("#match")).toBeVisible();
  await expect(page.locator("#producer-select option").filter({ hasText: "Barracks" })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Center on HQ", exact: true }).click();
  await page.getByRole("tab", { name: "Build", exact: true }).click();
  await noOverflow(page);
  await expect.poll(() => canvasColors(page)).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("mobile-base.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow(page);
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  await expect(page.getByRole("button", { name: "Weapons 100 material + 50 catalyst / 15s", exact: true })).toBeDisabled();
  await noOverflow(page);
  await page.getByRole("button", { name: "Surrender and leave", exact: true }).click();
  await page.getByRole("button", { name: "Surrender", exact: true }).click();
  await expect(page.locator("#lobby")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("stdbrts:practice:")).length)).toBe(0);
  expect(errors).toEqual([]);
});

test("desktop and touch multiplayer flow", async ({ browser }, testInfo) => {
  // This now plays a match through to a result so it can assert the score
  // screen, which does not fit the 60s default.
  test.setTimeout(180000);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await desktop.newPage();
  const peer = await mobile.newPage();
  const errors: string[] = [];
  host.on("pageerror", error => errors.push(error.message));
  peer.on("pageerror", error => errors.push(error.message));
  const database = process.env.STDB_DATABASE ?? "stdbrts-playtest";
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
    // Faction follows the slot until somebody chooses: the host is Industrial
    // and the peer Network, and both are legible before anyone deploys.
    await expect(host.locator("#roster")).toContainText("Industrial");
    await expect(host.locator("#roster")).toContainText("Network");
    await expect(host.locator("#faction-brief")).toContainText("You are Industrial");
    await expect(peer.locator("#faction-brief")).toContainText("You are Network");
    // The peer departs from what the slot dealt. The choice is server state, so
    // it has to reach the other player's roster, not just the chooser's own.
    await peer.locator("#faction").selectOption("organic");
    await expect(peer.locator("#faction-brief")).toContainText("You are Organic");
    await expect(peer.locator("#faction")).toHaveValue("organic");
    await expect(host.locator("#roster")).toContainText("Organic");
    await expect(host.locator("#roster")).not.toContainText("Network");
    await expect(host.locator("#faction-brief")).toContainText("You are Industrial");
    await host.getByLabel("Ready", { exact: true }).check();
    await peer.getByLabel("Ready", { exact: true }).check();
    await host.getByRole("button", { name: "Deploy", exact: true }).click();
    await expect(host.locator("#match")).toBeVisible();
    await expect(peer.locator("#match")).toBeVisible();
    await expect.poll(() => canvasColors(host)).toBeGreaterThan(20);
    await expect.poll(() => canvasColors(peer)).toBeGreaterThan(20);
    await noOverflow(host);
    await noOverflow(peer);
    // Each side knows its own faction and its opponent's once the match starts,
    // and the peer deployed as the faction it chose, not the one it was dealt.
    await expect(host.locator("#faction-readout")).toContainText("INDUSTRIAL");
    await expect(peer.locator("#faction-readout")).toContainText("ORGANIC");
    await expect(host.locator("#battle-players")).toContainText("Organic");
    await expect(peer.locator("#battle-players")).toContainText("Industrial");
    // Put an opening worker on the deposit beside the host's hub explicitly.
    // Labour already starts gathering on its own — the server assigns each
    // labourer to its nearest deposit the moment the match begins — so
    // nothing here is needed to make the host mine. What this still proves is
    // that a player-issued gather order actually reaches the server and shows
    // up in the command feed, which is why "Select idle worker" no longer
    // works as the selection step: with labour already gathering, no worker
    // is ever idle, so that button stays disabled for the rest of the match
    // and clicking it would wait forever. A box drawn around the spawn point
    // selects the same worker by position instead.
    // The box must cover the whole main base, not just the spawn point: labour
    // starts gathering at tick 0 and has already walked out to the mineral arc
    // (radius ~215 around the hub) by the time this runs. A box drawn tightly
    // around the spawn selects nothing and passes only by luck of timing.
    await worldBoxSelect(host, 370, 370, 840, 840);
    await worldOrder(host, 639, 389);
    await expect(host.locator("#command-list")).toContainText("gather");
    // The choice is frozen at deployment: the lobby, and the only control that
    // could change a faction, are gone for the rest of the match.
    await expect(peer.locator("#faction")).toBeHidden();
    // The peer is Organic, so its card offers a harvester and neither of the
    // other two labour units, and harvester stock is a real readout for it —
    // while the host below still buys the worker its own faction trains.
    await expect(peer.getByRole("button", { name: "Harvester free / 2s", exact: true })).toBeVisible();
    await expect(peer.getByRole("button", { name: /^Worker/ })).toHaveCount(0);
    await expect(peer.getByRole("button", { name: /^Drifter/ })).toHaveCount(0);
    await expect(peer.locator("#stock-readout")).toBeVisible();
    await expect(host.locator("#stock-readout")).toBeHidden();
    await expect(host.getByRole("button", { name: /^Harvester/ })).toHaveCount(0);
    await host.setViewportSize({ width: 1920, height: 1080 });
    await noOverflow(host);
    await host.setViewportSize({ width: 1440, height: 1000 });
    await peer.setViewportSize({ width: 320, height: 740 });
    await noOverflow(peer);
    await peer.setViewportSize({ width: 390, height: 844 });
    await host.getByRole("button", { name: "Set rally destination", exact: true }).click();
    await expect(host.locator("#targeting-state")).toHaveText("Rally target");
    // A raw screen click assumed the old map filled the viewport; aim in world
    // space instead. The regex matters too: "Rally " also matches "Rally unset",
    // so the old assertion passed even when no rally had been set.
    await worldClick(host, 1000, 1000);
    await expect(host.locator("#rally-status")).toHaveText(/Rally \d+, \d+/);
    await expect(host.getByRole("button", { name: "Clear rally", exact: true })).toBeEnabled();
    // The opening stipend pays material every few ticks, so an absolute balance
    // is no longer a stable readout. Each purchase is asserted as a dip of at
    // least its price less a few seconds of stipend, which is still specific:
    // the stipend can only ever raise the balance, so any dip is a charge.
    const material = () => host.locator("#material").innerText().then(Number);
    await expect(host.locator("#catalyst")).toHaveText("0");
    const opening = await material();
    expect(opening).toBeGreaterThanOrEqual(250);
    // Soldier is trained only at a barracks now, never at the hub, so the host
    // builds one first — before training anything else. That ordering matters:
    // once a unit trains, it walks the (600, 600)-(1000, 1000) rally line set
    // above, and that line runs straight down the one gap in the ring of
    // deposits around the hub — the only corridor the pathfinder ever routes
    // through to leave the base. A site merely 55 units off that line, such as
    // (680, 720) (legal in isolation elsewhere in this repo), gets "obstructed"
    // out from under the build order the moment a walking unit is nearby, so
    // the barracks goes up while the only units near the hub are still the
    // stationary starting soldier and the two labourers already off mining in
    // the opposite direction. (600, 750) itself is clear of terrain, at least
    // 110 from the hub, at least 75 from every deposit, and within 500 of the
    // hub.
    await host.getByRole("tab", { name: "Build", exact: true }).click();
    await host.getByRole("button", { name: "Barracks 150 material / 8s", exact: true }).click();
    await expect(host.locator("#targeting-state")).toHaveText("Place Barracks");
    await worldClick(host, 600, 750);
    await expect(host.locator("#command-list")).toContainText("build barracks");
    // Material is charged the moment construction starts, not when it
    // finishes, so the dip is checked here rather than after the wait below.
    await expect.poll(material).toBeLessThanOrEqual(opening - 120);
    await expect(host.locator("#producer-select option").filter({ hasText: "Barracks" })).toHaveCount(1, { timeout: 25000 });
    const afterBarracks = await material();
    // The building that just placed the barracks is now the selection, not a
    // producer, so this still trains at the hub by fallback — the same
    // fallback the rally target above landed on.
    await host.getByRole("tab", { name: "Production", exact: true }).click();
    await host.getByRole("button", { name: "Worker 50 material / 3s" }).click();
    await expect(host.locator("#command-list")).toContainText("train worker");
    await expect.poll(material).toBeLessThanOrEqual(afterBarracks - 35);
    await expect(host.locator("#unit-count")).toHaveText("4 / 60");
    const afterWorker = await material();
    // Now hand the command card to the barracks explicitly, to train the
    // soldier it alone can produce.
    const barracks = await host.locator("#producer-select option").filter({ hasText: "Barracks" }).getAttribute("value");
    await host.getByLabel("Production building", { exact: true }).selectOption(barracks!);
    await expect(host.locator("#selection-title")).toHaveText("Barracks");
    await host.getByRole("button", { name: "Soldier 100 material / 5s" }).click();
    await expect.poll(material).toBeLessThanOrEqual(afterWorker - 80);
    // Neither unit costs catalyst, and nothing the host owns is mining any.
    await expect(host.locator("#catalyst")).toHaveText("0");
    const afterSoldier = await material();
    await host.getByRole("button", { name: "Cancel all unfinished production", exact: true }).click();
    // The unstarted soldier is refunded in full and exactly once: 100 material
    // back, and no catalyst invented along the way.
    await expect.poll(material).toBeGreaterThanOrEqual(afterSoldier + 100);
    expect(await material()).toBeLessThan(afterSoldier + 200);
    await expect(host.locator("#catalyst")).toHaveText("0");
    await expect(host.locator("#production-queue")).toBeEmpty();
    // Selecting the army moves the current selection off the barracks and onto
    // a unit that is not itself a producer, so the rally controls below fall
    // back to acting on the hub again — where the rally was set — rather than
    // on the barracks, which never had one.
    await host.getByRole("button", { name: "Select army", exact: true }).click();
    await expect(host.locator("#selection-title")).toHaveText("Soldier");
    await expect(host.getByRole("button", { name: "Clear rally", exact: true })).toBeEnabled();
    await host.getByRole("button", { name: "Clear rally", exact: true }).click();
    await expect(host.locator("#rally-status")).toHaveText("Rally unset");
    await expect(host.getByRole("button", { name: "Repair", exact: true })).toBeDisabled();
    const canvas = host.locator("#battlefield");
    await host.getByRole("button", { name: "Attack-move", exact: true }).click();
    await expect(host.locator("#targeting-state")).toHaveText("Attack-move target");
    // Aim in world space, not at a screen pixel: where a raw canvas click lands
    // depends on the camera, and it used to be hidden by the order clamp that
    // forced every point into the old 1600 extent.
    await worldClick(host, 1300, 1400);
    await expect(host.locator("#selection-order")).toHaveText("attack move");
    await host.getByRole("button", { name: "Hold position", exact: true }).click();
    await expect(host.locator("#selection-order")).toHaveText("hold");
    await host.keyboard.press("a");
    await expect(host.locator("#targeting-state")).toBeVisible();
    await host.keyboard.press("Escape");
    await expect(host.locator("#targeting-state")).toBeHidden();
    await expect(host.locator("#selection-title")).toHaveText("Soldier");
    const before = await canvas.screenshot();
    await canvas.click({ position: { x: 520, y: 280 }, button: "right" });
    await expect(host.locator("#command-list")).toContainText("move / 1");
    await expect.poll(async () => host.locator("#pending-count").innerText()).toBe("0");
    const after = await canvas.screenshot();
    expect(before.equals(after)).toBe(false);
    await host.screenshot({ path: testInfo.outputPath("desktop-match.png") });
    const beforeReload = await material();
    await host.reload();
    await expect(host.locator("#status")).toHaveText("Connected");
    await expect(host.locator("#match")).toBeVisible();
    // Both balances are authoritative server state: the reload recovers them,
    // and only the stipend may have moved material in the meantime.
    const afterReload = await material();
    expect(afterReload).toBeGreaterThanOrEqual(beforeReload);
    expect(afterReload).toBeLessThan(beforeReload + 60);
    await expect(host.locator("#catalyst")).toHaveText("0");
    await expect(host.locator("#unit-count")).toHaveText("4 / 60");
    await peer.getByRole("button", { name: "Select army", exact: true }).click();
    await peer.getByRole("button", { name: "Attack-move", exact: true }).tap();
    await peer.locator("#battlefield").scrollIntoViewIfNeeded();
    // The middle of the map, well away from the peer's own base at (2600, 600).
    await worldTap(peer, 1600, 1600);
    await expect(peer.locator("#selection-order")).toHaveText("attack move");
    await peer.getByRole("button", { name: "Hold position", exact: true }).tap();
    await expect(peer.locator("#selection-order")).toHaveText("hold");
    await peer.getByRole("radio", { name: "Order", exact: true }).check();
    await peer.locator("#battlefield").scrollIntoViewIfNeeded();
    await worldTap(peer, 1800, 1400);
    await expect(peer.locator("#command-list")).toContainText("move / 1");
    await noOverflow(peer);
    await peer.screenshot({ path: testInfo.outputPath("mobile-match.png"), fullPage: true });
    await peer.getByRole("button", { name: "Surrender and leave", exact: true }).click();
    await peer.getByRole("button", { name: "Surrender", exact: true }).click();
    await expect(peer.locator("#lobby")).toBeVisible();
    await expect(host.locator("#result-title")).toHaveText("Victory");

    // --- The post-match score screen ---------------------------------------
    // The concession above is a real end to a real match, so the host now has
    // the whole `match_sample` history the server wrote for both commanders.
    const scoreboard = host.locator("#scoreboard");
    await expect(scoreboard).toBeVisible();
    // Both commanders are named, with their faction — including the one who
    // conceded, whose `player` row left the room with them. Without the
    // roster the client keeps while a match runs, that line would be "Slot 1".
    await expect(host.locator("#score-roster")).toContainText("North / Commander");
    await expect(host.locator("#score-roster")).toContainText("South / Commander");
    await expect(host.locator("#score-roster")).toContainText("Industrial");
    await expect(host.locator("#score-roster")).toContainText("Organic");
    await expect(host.locator("#score-roster .score-badge.win")).toHaveText("Winner");
    // The conceding side is marked out at the moment its forces went. A
    // concession removes them outright, so it looks exactly like a rout in the
    // samples and the badge says only that they were out, not which it was.
    await expect(host.locator('#score-roster tr[data-slot="1"] .score-badge.out')).toBeVisible();
    await expect(host.locator('#score-roster tr[data-slot="0"] .score-badge.out')).toHaveCount(0);
    // Four panels: the two graphs that were asked for, and the two that
    // explain them. Each is titled in place, not left to a legend.
    await expect(host.locator(".score-panel")).toHaveCount(4);
    for (const panel of ["income", "army", "banked", "labour"]) {
      await expect(host.locator(`.score-panel[data-panel="${panel}"]`)).toBeVisible();
    }
    // Income is mined income and says so, in the same words every time.
    await expect(host.locator('.score-panel[data-panel="income"] .score-caption')).toContainText("opening stipend");
    await expect(host.locator('.score-panel[data-panel="income"] .score-caption')).toContainText("Cumulative mined");
    // One line per commander, in that commander's battlefield colour — and
    // never only in that colour: slot 0 is solid and slot 1 is dashed, each
    // ends in its own marker shape, and each carries its name at the line end.
    const income = host.locator('.score-facet[data-facet="mined-material"]');
    await expect(income).toHaveCount(1);
    await expect(income.locator('.score-line[data-slot="0"]').first()).toHaveAttribute("stroke", "#66dfba");
    await expect(income.locator('.score-line[data-slot="1"]').first()).toHaveAttribute("stroke", "#ed7c8b");
    await expect(income.locator('.score-line[data-slot="0"]').first()).toHaveAttribute("stroke-dasharray", "");
    await expect(income.locator('.score-line[data-slot="1"]').first()).toHaveAttribute("stroke-dasharray", "8 4");
    await expect(income.locator('.score-end[data-slot="0"]')).toContainText("North");
    await expect(income.locator('.score-end[data-slot="1"]')).toContainText("South");
    await expect(income.locator('circle[data-slot="0"]')).toHaveCount(1);
    await expect(income.locator('rect[data-slot="1"]')).toHaveCount(1);
    // Material and catalyst never share an axis: a catalyst facet is its own
    // chart when there is any catalyst at all, and absent when there is none.
    const catalyst = host.locator('.score-facet[data-facet="mined-catalyst"]');
    expect(await catalyst.count()).toBeLessThanOrEqual(1);
    await expect(host.locator('.score-facet[data-facet="mined-material"] figcaption')).toHaveText("Material mined");
    // Every value is reachable without a pointer: focusing a plot opens the
    // same readout hovering does, and the table view carries the whole series.
    await host.locator(".score-plot").first().focus();
    await expect(host.locator("#score-tip")).toBeVisible();
    await host.getByText("Show every sample as a table", { exact: true }).click();
    await expect(host.locator("#score-table .score-table-block").first()).toBeVisible();
    // The same counter, read the other way, without leaving the screen.
    await host.getByRole("button", { name: "Show income per minute", exact: true }).click();
    await expect(host.locator('.score-facet[data-facet="mined-material"] figcaption')).toHaveText("Material per minute");
    await host.getByRole("button", { name: "Show cumulative income", exact: true }).click();
    await expect(host.locator('.score-facet[data-facet="mined-material"] figcaption')).toHaveText("Material mined");
    await host.screenshot({ path: testInfo.outputPath("desktop-score.png") });
    await host.setViewportSize({ width: 990, height: 650 });
    await noOverflow(host);
    await expect(host.locator('.score-facet[data-facet="mined-material"] .score-plot')).toBeVisible();
    await host.screenshot({ path: testInfo.outputPath("short-score.png") });
    // The score screen covers the play area but never the match bar, so the
    // control that was always the way out is still there beside its own.
    await expect(host.getByRole("button", { name: "Surrender and leave", exact: true })).toBeVisible();
    await host.getByRole("button", { name: "Return to lobby", exact: true }).click();
    await expect(host.locator("#lobby")).toBeVisible();
    await expect(host.locator("#scoreboard")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
    await mobile.close();
  }
});