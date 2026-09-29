# Honeybadger Research Ledger

Research date: 2026-09-19; primary source replaced 2026-09-29. Status: planning evidence, not an implementation specification.

**Read this first (2026-09-29).** The author supplied a changelog spreadsheet (H0) as a better account of the mod than the website page (H1) this ledger was first built on. H0 is now the primary source; it is transcribed in [REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md) and summarized in the next section. The H1 sections further down are kept as a record of an **earlier version** of the mod. Where H0 and H1 disagree, H0 wins. Where only H1 describes something, treat it as possibly obsolete, not as documented fact.

## Sources and confidence

- **H0: the author's changelog spreadsheet (primary).** [Published sheet](https://docs.google.com/spreadsheets/d/e/2PACX-1vT1YxwepoM8Iu1c73e5X9ZnIseoCoub0Xv4O5CCwo1F8NylZsGLCbCHrvyPEY8tni340Y6BRR3dOzZ7/pubhtml), transcribed in [REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md). General and per-race rules, four global tiers of ability upgrades, and a stat table for about 70 units. Undated.
- **H1: published mod description and changelog (earlier version).** [mod_information.html](https://bitbucket.org/Thalagor/honeybadger/src/master/information_sites/templates/mod_information.html), read through the authenticated browser. The rules below are paraphrased from this page, including its General, Protoss, Zerg, Terran, and strategy sections.
- **H2: play instructions.** [how_to_play.html](https://bitbucket.org/Thalagor/honeybadger/src/master/information_sites/templates/how_to_play.html). Describes SC2 Custom > Melee > any map > Create with Mod > search for Honey Badger.
- **H3: repository.** [honeybadger master](https://bitbucket.org/Thalagor/honeybadger/src/master/). The inspected tree is a Django website with information pages, player features, and static assets. Its root displayed a last-update date of 2021-05-17. This is not proof of the date of the mod's final release.
- **Local baseline:** [engineering history](../ENGINEERING.md), [playtest checklist](../PLAYTEST.md), and the existing Rust/TypeScript implementation. Previous passing test counts are historical evidence, not tests rerun during this planning task.

H1 is design documentation, not verified executable mod data. The inspected files do not establish access to the SC2 editor project, dependencies, trigger code, replay pack, or final published version. Source links currently track `master`; a commit-pinned archival reference remains to be established. No account database or credential configuration was inspected.

**Author clarification:** the website is a good initial summary; actual mod files can be retrieved later. Preserve all three economic identities, zone advantages, resource-purpose differences, and the major signature mechanics, not exact units. Start desktop 1v1. Keep tunable intentional delay and explore configurable automatic behavior to reduce dependence on micro. See [confirmed decisions](README.md).

## Additional research leads

The inspected [home page template](https://bitbucket.org/Thalagor/honeybadger/src/master/information_sites/templates/index.html) reinforces remote mining/recall/transfer, mobile harassment/automatic refineries, and free workers/death-spawns as headline mechanics. H1 links these overview videos, explicitly labeled old versions: [Protoss](https://www.youtube.com/embed/dlHN9ASxFvg), [Terran](https://www.youtube.com/embed/SOJVPUN3nLc), [Zerg](https://www.youtube.com/embed/KnSz9QKDSeE). It also embeds Twitch video IDs `901796698` (changelog discussion) and `997955236` (tournament). These videos have not been watched or verified in this research pass.

H1 identifies two design inspirations: [comeback opportunities](https://www.reddit.com/r/FrostGiant/comments/jo36xq/comeback_opportunities_will_determine_the_games/) and [volatility rather than difficulty](https://www.reddit.com/r/FrostGiant/comments/jsa0uh/the_volatility_of_rts_games_not_the_difficulty_is/). They are leads, not additional evidence read during this pass. No editor-project download was found in the inspected information/home/play-instruction pages; this is not a claim that no such files exist elsewhere.

Labels throughout this plan: **Documented** means H0 (or, for the earlier version, H1/H2) explicitly says it; **Observed** means inspected in this workspace; **Inferred** means a likely gameplay consequence; **Proposed** means a new-game design recommendation; **Unresolved** means evidence or a user decision is still needed. Numeric values below are historical reference values, not automatically approved balance for the new game. Source faction/unit names identify reference mechanics only, not proposed shipped names or assets.

## Identity worth preserving

**Documented:** lower income, cheaper expansion, slower access to late-game technology, early aggression, and harassment. The stated economic goal is to make expansion and recovery attractive without making either safe. Worker losses and missed worker production should be less punishing. Macro growth should create new harassment opportunities.

**Documented faction themes:** organic territory that can grow and collapse; a network enabling persistent map presence and strong individual units; territorial exploitation with versatile defense and mobile offensive opportunities.

**Inferred:** the design's core is economic geography and recoverable conflict, not merely a large roster. Maps, scouting, fragile infrastructure, and ways to move between fronts are first-class mechanics.

## The mod according to H0 (primary)

Full transcription: [REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md). H0 times are SC2 Normal-speed seconds (divide by 1.4 for real time on Faster), and its speeds and ranges assume every tier upgrade is done.

### What H0 establishes

| Area | Documented in H0 | Inferred for this project |
| --- | --- | --- |
| Construction | Every race builds with a **hero builder**. Structures go within 40 range of another *finished* structure. Static defense only in powerfield, on creep, or near a sensor tower. No building on the opponent's half for the first X minutes. | Supports the settled command-card construction (no builder unit per worker) and an adjacency rule this game does not yet have. X is unknown. |
| Upgrades | All research is on the hero builder, **instant**, and global (one +attack covers ground and air). Plus four global **tiers** costing 500, 750, 1000 and 7500, each unlocking a race-specific bundle of abilities and speeds. | Research as a player-level purchase fits Increment K's move of research onto the player. The lab-with-a-timer model does not match. |
| Resources | Minerals and gas are **infinite** and replenish periodically. Gas buildings mine gas automatically for every race. A third resource, **Terrazine**, comes from mining minerals and pays for static defense. | Depletion is not a source mechanic. The autonomous gas extractor is general, not Industrial-only. Terrazine gives the third currency a single narrow purpose. |
| Prices | The unit table's cost column is priced as if in **gas** (its derived columns are "per 100 gas"). Tier cost currency is not stated. | Unresolved. If units cost gas, minerals fund structures and tiers and the dual-currency split is not material-for-units/catalyst-for-tech. |
| Refunds | Army units 50%; gas buildings 50%; Zerg bases 50%; Protoss probes 50%. | Wider than the implemented army-only refund. |
| Visibility | No unit is ever cloaked, burrowed ones included. | Consistent with the demoted fog and no detection. |
| Map | Mineral walls become destructible rocks. Structures capture Xel'Naga towers. | Map features, not yet in the map format. |
| Protoss | Probes mine without a base; probes refund 50%. Powerfield regenerates shield +0.5/s, **life** +0.5/s and energy +0.25/s (tier 3 adds +0.3/+0.15). Shields regenerate **in combat**. Dying in a powerfield regenerates nearby shields. **Ricochet**: overkill bounces to a nearby unit. Pylons see very far and over cliffs. Cannons and batteries work unpowered; batteries start at 0 energy. | Matches the implemented no-return mining and death restoration. Differs from the implemented 10s shield-regeneration delay and hit points that never regenerate. Ricochet is new. |
| Zerg | Burrowed units regenerate faster and can move. Units dying on the owner's creep leave time-limited broodlings, infested terrans or mosquitolisks. Bases refund 50%. Lair and Hive make larvae 50% faster. The free Harvester has 9 life. Infestors summon an uncontrollable Queen. | Matches the implemented owner-only death spawns and free harvesters. Burrow is new. |
| Terran | 20% more Terrazine. **Sensor towers** give friendly army units a large speed boost. Tech reactors on barracks, factory and starport allow research and double production. Orbitals send **repair drones** (75 energy, about 300 life healed, one drone per target). The Command Center starts with 16 SCVs. | Matches the implemented sensor tower. Repair drones are a candidate Industrial ability, which the 2026-09-25 decision left open. |
| Roster | About 70 units with stats, including non-standard ones: Noogard, Warhound, HERC, Scout, Odin, Mosquitolisk, Locust from larva. Many units carry reworked abilities (Colossus energy volleys, Dark Templar rage, Immortal damage cap, Oracle energy armour). | Reference for roles and relationships only. The project does not copy the roster. |

### Where H1 (earlier version) disagrees or is not confirmed

| H1 rule | H0 status |
| --- | --- |
| Bases exhaust about 30% faster; finite deposits | **Contradicted**: resources are infinite. |
| Opening stipend of 200 then 100 minerals/minute | Not in H0. |
| Army refunds 50%, but workers and structures excluded | **Contradicted in part**: gas buildings, Zerg bases and Protoss probes also refund 50%. |
| 2x HP/shields, doubled static-defense damage, 1.5x spell durations and burst damage | Not in H0. H0 lists absolute stats instead. |
| Protoss Pylon Walk, Warp Gate timing, Pylon Overcharge, shield-funded Nexus Recall | Not in H0. H0 has Mothership Core Mass Recall to Nexus, with a tier 3 upgrade to its area and pre-recall stun. |
| Zerg harvester conversion (combine four into a drone; sacrifice for creep), injection, queen sacrifice | Not in H0. H0's Queen is summoned by the Infestor. |
| Terran Retreat, HERC smoke, refinery suppression/burning, refinery output switch to minerals | Not in H0. The author called smoke, retreat and suppression leftovers of earlier versions (2026-09-25). HERC exists in H0 as barracks infantry with no smoke. |
| Rich-mineral harvest amounts | Not in H0. |

**Inferred:** H0 describes a later and substantially reworked version. Several of the author's own statements made while this project was being built already matched H0 rather than H1: construction with no builder unit, the sensor tower, restoration on death in the powerfield, ground/air death spawns, and dropping smoke/retreat/suppression.

## General rules (H1, earlier version)

| Reference rule | Documented detail | Interpretation limit |
| --- | --- | --- |
| Economic pace | Summary estimates half normal SC2 income; bases exhaust about 30% faster | No patch, measurement method, or exact resource-node amounts given |
| Loss refund | Army deaths refund 50%; workers, structures, and overlords excluded | Mineral/gas basis, morph costs, summons, ownership changes, and rounding unspecified |
| Opening stipend | 200 minerals/minute for first 90s; 100/minute for next 90s | Payment cadence unspecified; continuous interpretation totals 450 minerals |
| Durability | Units and buildings receive 2x HP/shields, excluding workers, main bases, and static defenses | Exact exception list includes probe/harvester/drone/SCV; nexus/hatchery/lair/hive/CC/OC/PF; missile turret/cannon/spine/spore |
| Defensive damage | Planetary fortress, cannon, spine, spore, and bunker damage doubled | Bunker multiplier's implementation and stacking unresolved |
| Sustained spells | 1.5x duration: fungal, parasitic bomb, blinding cloud, microbial shroud; storm, force field, prismatic alignment, guardian shield, time warp; interference matrix, anti-armor missile | Page also describes 1.5x total damage, which does not apply literally to non-damaging spells |
| Burst attacks | 1.5x damage: Yamato, baneling, EMP shield damage, disruptor projectile, widow mine | Exact upgrade/armor interactions unspecified |
| Basic melee | Zergling damage 5 to 4; zealot 8 to 7 per strike | Relative to an unspecified vanilla version |
| Rich minerals | Harvest amount: Zerg 1 to 2; Terran 3 to 5; Protoss 5 to 8; MULE excluded | Does not itself specify trip duration |

## Network faction reference: Protoss (H1, earlier version)

| Area | Documented rules |
| --- | --- |
| Opening | 9 probes; 200 minerals and 50 gas |
| Worker | 30 minerals; 5 HP/25 shields; detailed section says 40% faster construction; introductory example says 50% faster, an unresolved inconsistency |
| Mining | Minerals need no return trip to nexus; saturated line approximately 400 minerals/minute; two gas workers give full return, third gives a smaller marginal benefit |
| Worker support | Give-energy ability greatly increases energy regeneration; target/cost/duration/range not specified |
| Pylon | 50 minerals; 4 supply; no shields |
| Pylon Walk | All units including flyers transfer after a short delay from a pylon to any powerfield, including a mobile prism; 4s immobilized/non-attacking arrival state until warp-gate research removes it |
| Warp gate | More expensive and longer research, without exact values; all warp-ins take 4s |
| Pylon Overcharge | Nexus ability; 60 minerals; pylon within range 30; weapon damage 32; lasts 14s |
| Nexus | 200 minerals; 500 HP/250 shields instead of 1000/1000; described as building 50% faster; initially no abilities |
| Psionic Defense | 100 minerals/50 gas, 22s; adds 500 shields and unlocks nexus abilities; base plus upgrade time described as 80% normal |
| Recall | Costs 250 nexus shields; local 30s cooldown rather than global; 0.5s channel instead of 4s; incoming damage interrupts affected recalled units; 3s inactive arrival instead of 0.8s |
| Late economy upgrade | Templar Archive, requires Fleet Beacon; worker supply becomes 0.5; increases mineral gathering and pylon sight; price and multipliers unspecified |
| Mobility upgrade | Void Ray speed upgrade instead makes its Pylon Walk behave like Blink; exact conditions not stated |
| Tech access | Cyber Core no longer needs Gateway; Gateway/Robotics/Stargate/Cyber Core construction described as 50% faster |
| Other tuning | Observer cost 25/75 to 75/25; Oracle/Phoenix energy regeneration doubled; battery-overcharge range 8 from casting nexus |

**Inferred interactions:** expansion need not be centered on a town hall; vulnerable workers and relay infrastructure become the economy's attack surface. Relays provide both reinforcement and escape paths. Supply and strategic mobility share a destructible dependency. Shield-funded recall spends base defense to save units. The upgrade removing arrival vulnerability is a major timing window, not a cosmetic upgrade.

## Organic faction reference: Zerg (H1, earlier version)

| Area | Documented rules |
| --- | --- |
| Opening | 16 harvesters, 1 drone, 50 minerals |
| Territory | Creep decays much faster; almost all structures cost 50 more minerals except hatchery; units dying on creep create short-lived broodlings, more for expensive units |
| Tumors | Killing one reactivates the nearest inactive tumor within 10; visible before Infestation Pit; slightly smaller spread |
| Hatchery | 150 minerals, 0 supply, 600 HP, reduced creep radius; described as building 60% faster; starts with 4 larvae, very slow passive generation, cap 7 |
| Lair | Upgrade 200 minerals/75 gas; requires Pool OR Roach Warren OR Hydralisk Den |
| Extractor | 150 HP, very fast construction; exact cost/time not given here |
| Queen | 100 minerals; no Pool prerequisite; smaller; 80 HP; slower regeneration, max 75 energy; slower off creep; reduced ground/air damage and ground range |
| Injection | 2 larvae, longer incubation; described as roughly twice passive hatchery larva-generation rate |
| Queen sacrifice | Creates 2 infested terrans after 3s egg stage; units last 20s and have high damage; exact damage unspecified |
| Harvester | Free; one larva creates two; four harvesters use one supply; cannot build or fight; dies quickly off creep |
| Harvesting | Each trip carries one mineral or gas; 32 mineral harvesters and 8 gas harvesters described as optimal |
| Harvester conversion | Sacrifice one for temporary creep; combine four into one building-capable drone |
| Drone | Mines like one harvester; can build and weakly attack; slightly more HP than normal; creates two broodlings on death |
| Overlord | Faster base speed; creep generation available immediately |
| Creeping Queens | Hive upgrade gives queens mobile creep trails, fast movement everywhere, and creep-spreading anywhere |
| Tech branches | Roach Warren needs no Pool; Hydralisk Den available on hatch tech, upgrades still need Lair; Lurker Den only needs Lair |
| Nydus | Worm cost 75/75 to 25/25 |

**Inferred interactions:** workers are free in currency but cost larvae, supply, space, and territory. Worker recovery competes with army production. Cutting creep can destroy both income and mobility. Disposable creep sources and larva-rich new bases enable aggressive recovery. Broodlings reward fighting on home territory and prolong battles, while also increasing entity count and on-death processing risk.

## Industrial faction reference: Terran (H1, earlier version)

| Area | Documented rules |
| --- | --- |
| Opening | 10 workers; 200 minerals and 50 gas |
| Retreat | All army units receive movement-speed value written as `1.5` for 14s, then approximately 5s faint; likely a multiplier, but source does not explicitly resolve this |
| Production | Barracks/Factory/Starport/add-ons described as building 50% faster |
| SCV | 30 minerals; 3 damage; 3 minerals/trip; slow gas harvesting with one worker per gas optimal; morph to HERC costs 25 minerals |
| HERC | Requires depot; 65 HP, 2 armor, 6 damage, weapon-speed value 1.79; can repair and use smoke; timing units for weapon speed unstated |
| Smoke | Opponent-only 2x2 sight blocker; owner sees through it; 20s cooldown, 10s duration, 2 charges |
| MULE | Half normal lifetime; can collect refinery gas; receives no rich mineral/gas benefit |
| Refinery | Automatically produces 5 gas every few seconds; stops automatic income under attack; starts burning at 375/500 HP; switch output to 7 minerals; mineral output approximately 2.5 worker equivalents |
| Rich refinery | Automatic output 7 gas or 10 minerals instead of 5/7 |
| Command Center | 300 minerals; described as building 25% faster; HP reduced from 1500 to 1000 |
| Planetary upgrade | 150/75 instead of 150/150 |
| Orbital | Requires Barracks OR Factory; 1000 HP instead of 1500; scan 25 energy |
| Tech access | Barracks and Factory available without prerequisites; Starport requires either |
| Boost | Requires Starport; available on Reaper, Hellion, Cyclone; Medivac retains normal boost |

**Inferred interactions:** distant gas sites become dual-resource outposts rather than worker destinations alone. Harassment can suppress income without destroying structures. Repair and defense matter because suppression and burning threaten cheap growth. Faster harassment and retreat create initiative, but post-retreat vulnerability prevents a free disengage. Asymmetric smoke requires genuine player-specific vision, not a shared visual particle.

## Unknowns that must not silently become facts

1. Whether H0 is the final mod revision (it is undated); actual SC2 data/trigger project and dependency patch.
2. The currency of H0's unit costs (the sheet implies gas) and of its tier costs; how Terrazine accrues from mineral mining and what static defense costs in it.
3. H0's "first X minutes" build restriction, the replenishment rate of infinite resources, and the automatic gas extractor's rate.
4. Teleport channel length, source radius, destination occupancy, mobile-field handling, and relay destruction during transit. (H0 does not describe powerfield teleport at all.)
5. Creep growth/decay rates, larva cadence, which units leave broodlings versus infested terrans versus mosquitolisks and how many, lifetimes and recursive exclusions.
6. Refund calculation for minerals/gas, morph chains, temporary units, cancellation, friendly fire, and simultaneous elimination. H0 names the eligible entities but not the basis.
7. Which spells, inherited SC2 mechanics, and faction interactions the author considers essential. Documented presence is not evidence of priority or enjoyment.
8. Exact map pool, practical game length, army size, supply cap, competitive formats, and desired treatment of air, detection, elevation, transports, and siege.
9. Published examples and tournament videos can corroborate behavior, but old-version videos (and H1) must not override H0 without a revision match.

## SpacetimeDB references

- [Documentation](https://spacetimedb.com/docs).
- [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions): initial matching rows followed by updates; client filtering is not access control.
- [Scheduled tables](https://spacetimedb.com/docs/tables/schedule-tables): basis for authoritative scheduled simulation.
- [Access permissions](https://spacetimedb.com/docs/tables/access-permissions): private tables cannot be queried directly by clients; caller-aware views can expose restricted data; current documentation requires indexed view access.

The workspace has Rust module SDK 2.0.2 and CLI/client 2.1.0. Verify the chosen Rust view API, subscription behavior, index constraints, and migration support against installed versions in a small integration spike before finalizing schemas. The current website is not proof that every example compiles against these versions.