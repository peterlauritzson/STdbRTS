# Game Design

Status: proposed design informed by [documented mod rules](RESEARCH.md) and [confirmed author priorities](README.md). Faction labels below are working descriptions, not final names.

**Reference source changed 2026-09-29.** This document was first written from the mod's website page (H1), which describes an earlier version. The author's changelog sheet (H0, [REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md)) is now the reference. Passages resting only on H1 are marked below. Where the built game differs from H0, the open questions are listed in [DECISIONS.md](DECISIONS.md) (2026-09-29); settled entries there take precedence over this document.

## Pillars

1. Expansion creates opportunity and exposure. Cheap infrastructure should let players return to the map, not permanently fortify every resource.
2. Different economies create different vulnerabilities. Resource choice, travel, territory, production capacity, and supply must not collapse into one generic income multiplier.
3. Zones change what a player can do. Their benefits, boundaries, sources, and ways to dismantle them must be visible and meaningful.
4. Losing a fight should hurt without routinely ending the match. Refunds and accessible worker recovery compete with travel time, production, territory, and tech.
5. Players issue intentions and prepare responses. Units handle approved local tactics; players decide where, why, and under which constraints.
6. Spectacle serves readability. Distinct silhouettes, movement, hit reactions, and ability telegraphs matter more than particle volume.

## Resources and pacing

**Settled model (2026-09-29, author):** three spendable currencies, each buying one kind of thing, plus capacity limits and faction-specific local constraints. Names remain provisional. This is "a huge part of the schtick": because the army is paid in its own currency, there is never a reason not to build army.

| Resource or constraint | Strategic purpose | Spending/availability policy |
| --- | --- | --- |
| Material (minerals) | Growth and technology | Structures, research and ability tiers; finite deposits; permanent base income |
| Catalyst (gas) | The army | Army units only; per-base sites worked by automatic refineries, no workers |
| Terrazine | Static defense | Turrets only; earned as a by-product of mining material, Industrial +20% |
| Supply | Army/economy opportunity cost | Includes workers; faction infrastructure supports it; not a currency |
| Energy/charges | Local tactical availability | Unit/structure-specific regeneration and abilities; not freely transferable banked currency |
| Organic production stock | Free-worker and army production tradeoff | Local generation and capacity; free harvesters still consume stock and supply |
| Relay coverage | Strategic mobility and recovery | Destructible source-linked zones; not a currency |

This supersedes the 2026-09-22 two-currency split, in which material bought workers, buildings and basic troops and catalyst bought technology and specialists. Labour costs material. Catalyst comes from automatic refineries for every faction. Open: the refinery rate, the Terrazine rate, and a remembered cross-income rule (every X of one currency mined also yields Y of the other) whose values are unknown (DECISIONS.md, 2026-09-29).

Research is instant and global, bought from the command card with no research building, alongside four global ability tiers (H0).

Deposits stay finite for now (author, 2026-09-29), although H0's resources are infinite. Every player also receives **base income that never stops**, replacing the opening-only stipend. Evaluate income, travel, depletion, and build time together: lower income plus cheap bases alone does not guarantee active expansion. Base income and death refunds are tunable ruleset parameters, not hardcoded exceptions.

**Refund policy (settled 2026-09-29):** recover 50% of the actual paid investment in army units, gas buildings, Organic hubs and Network drifters. Track eligible investment through morphs without double counting. Other workers, other buildings, free summons, and expired temporary units are ineligible. Cancellation and death are distinct terminal events; never both pay. Friendly/self-inflicted deaths cannot create profit. Refunds are paid once after simultaneous deaths, cannot rescue a defeated player, and do not refund supply as currency. Final percentage and eligibility need playtests.

Do not blindly double every HP value: original multipliers depended on SC2 base statistics and defenses. Tune our own time-to-kill, warnings, pursuit, and escape opportunities around the chosen delay and available autonomous responses.

## Faction identity and counterplay

| Working faction | Economic loop | Zone advantage | Recovery and risk | Required counterplay |
| --- | --- | --- | --- | --- |
| Network | Cheap fragile workers mine material without a return trip; specialist-resource throughput still needs a defined separate loop | Destructible relays enable transport and reinforcement; later mobile fields | Rapid redistribution, shield-funded recall, inexpensive replacement; relay loss cuts movement and supply | Raid scattered workers, destroy relays, threaten landing areas, force shield expenditure |
| Organic | Free small harvesters consume shared production stock; combine workers into builders; large worker counts | Living terrain supports harvesting/survival, movement, and temporary death-spawns | Rebuild labor cheaply while territory survives; new hubs provide production; losing territory can cascade | Sever sources, exploit fast decay, attack fragile hubs, use area damage against dense labor |
| Industrial | Cheap conventional labor in large numbers (H0: 16 opening SCVs, 20% more Terrazine) | Sensor towers speed up friendly army inside their radius; static defense may be built there | Repair drones sent from hubs for energy heal hit points of any unit (settled 2026-09-29); double-production add-ons | Destroy sensor towers to take away mobility; catch the army outside tower coverage |

Row revised 2026-09-29. The earlier Industrial row (autonomous outposts switching output, smoke, suppression and burning, retreat) came from H1. The author called smoke, retreat and suppression leftovers of earlier versions, and H0 makes the automatic gas extractor common to every race rather than Industrial's identity. Settled 2026-09-29: Network shields regenerate in combat, and its power field also regenerates hit points and energy; Network gets ricochet (overkill bounces to a nearby enemy); Organic gets burrow (move and regenerate faster while burrowed, never hidden). The Network and Organic rows otherwise still stand, with two H0 notes: H0 has no powerfield teleport or shield-funded recall (it has a Mothership Core recall to base), and H0 Organic has no worker combination (already dropped, see DECISIONS.md).

No faction should be "the only one with automation." All receive the same behavior-program framework; faction abilities determine available actions.

### Network first loop

Mine away from a main base, establish a relay near a new deposit, reinforce it through the network, then decide whether to defend, recall, or concede the relay. Relay transfer needs visible source/destination conditions, a channel and arrival vulnerability, legal occupancy, and failure rules. First version uses stationary fields; mobile fields and upgrades that remove arrival penalties follow after counterplay is proven. Recall remains identity-critical but follows basic transfer because it adds interruption and a defensive resource cost.

### Organic first loop

Generate production stock, choose labor versus army, extend living ground, establish a vulnerable hub, and fight where losses spawn temporary defenders. Temporary terrain sacrifices and worker combination create expansion decisions. Test a severed territory region explicitly: decay should create a response window, not an unreadable instant mass death. Exact grace periods remain tunable. On-death children cannot recursively spawn or earn refunds.

### Industrial first loop

Mine conventionally with many workers, extend sensor-tower coverage to move the army quickly between fronts, fortify inside that coverage, and keep the army alive with repair. The loop's weakness is the towers themselves and fights outside their radius.

*Superseded 2026-09-29:* the earlier loop (take an exposed outpost, switch its output, protect it with smoke, suppress income by damage, retreat with a speed boost then vulnerability) was built from H1. The author turned smoke, retreat and suppression down on 2026-09-25, and H0 does not contain them.

## First playable roster

Use original unit designs with a few recognizable jobs, not one-for-one SC2 replacements. Each faction initially needs a labor role, a basic fighter, and a specialist/support role. It also needs its essential production/economy structures and signature territory source. Organic harvesters/builders are separate roles; industrial repair support and network relay support need not be separate combat units in the first slice.

The slice is deliberately unequal in implementation complexity. Equal unit counts are not a design goal. Add a siege/anti-static role once defenses work, then a limited area-denial capability and its autonomous counterplay. Defer broad air combat, transports, stealth, a large spell roster, and elaborate tech trees until the ground game succeeds. These remain roadmap candidates, not silently discarded mechanics.

## Zones as gameplay data

Zone definitions specify source, shape, owner, affected relations, eligible unit tags, lifetime, growth/decay, stacking, visibility, and effects. Keep these concepts separate:

- Movement passability and cost.
- Sight obstruction and detection.
- Projectile/weapon obstruction.
- Power/connectivity and ability eligibility.
- Economy/survival requirements.
- Combat and death effects.

Smoke need not stop bullets; living ground need not reveal every opponent; relay power need not block movement. Explicit rules prevent one overloaded "terrain" flag from deciding all six. Each effect must define whether overlapping sources add, refresh, use the strongest value, or merely grant eligibility. Friendly and enemy zones can overlap without silently changing ownership.

## Maps and victory

Desktop 1v1 first. Initial sandbox map includes mirrored starts, a reasonably defensible first expansion, exposed catalyst sites, two independent attack routes, and flanking space. Resource layouts must let every faction exercise its economic loop. Exact dimensions follow measured movement and order delays, not SC2 coordinate conversions.

The first release adds a second map that stresses split fronts and long relay/territory chains. Keep at least one expansion accessible without forcing a single choke. Rich nodes should create a choice, not dictate one opening. Test mirrored spawns and swapped faction assignments; symmetry alone does not prove matchup fairness.

**Victory (settled 2026-09-25, implemented as Increment K):** surrender or loss of all completed primary command hubs, with at least one completed hub required throughout the match. Incomplete emergency sites do not prolong elimination. This replaces the prototype's one-HQ assumption and must be decided before multi-base production is balanced. Define same-tick destruction as a draw when both lose their last hub. Disconnected players retain state under the existing grace/cleanup policy; disconnect is not surrender.

## Skill expression without compulsory micro

Scouting where to expand, selecting tech versus replacement, staging reinforcements, controlling territory sources, anticipating enemy priorities, and choosing behavior policies should matter. Mechanical input fluency still helps, but repeated move/attack spam should not be the strongest universal combat technique.

Begin with understandable behavior presets and editable thresholds. An advanced finite-state editor is a later extension of the same validated model, not a prerequisite for playing. Useful defaults are mandatory; players should not need to become programmers to compete.

## Impact tests

| Hypothesis | Experiment and evidence | Failure means |
| --- | --- | --- |
| Cheap growth creates exposed fronts | Compare income distribution, number of active bases, raid routes, and travel time across openings | Adjust geography, depletion, production, or defensive cost before adding units |
| Refunds allow recovery without endless stalemate | Track net investment lost, territory lost, replacement delay, and outcomes after first major fight | Change refund policy and throughput, not just damage |
| Free labor is constrained meaningfully | Compare production-stock allocation and recovery after worker versus territory losses | Labor needs a clearer opportunity cost or less catastrophic terrain dependence |
| Relay control is contestable | Replay channel starts, relay destruction, denied arrivals, and relocation choices | Mobility bypasses too much counterplay or fails too opaquely |
| Sensor-tower coverage matters | Compare army travel time and engagements won inside versus outside coverage; count towers destroyed | Tune radius and speed, or give the towers more to do |
| Delay plus behavior reduces required micro | Compare preset-only, customized-policy, and repeated-manual-order players on identical scenarios | Improve defaults, autonomy, warnings, or delay before adding reaction-heavy spells |
| Zone advantages are legible | Ask players to identify the source and cause of a loss from the battlefield/replay | Improve feedback and simplify stacking |

These are hypotheses, not proven balance results. Use short scripted fixtures followed by human playtests; do not mistake bot win rates for human balance. Record sample size, matchup, skill, rules version, and map for every conclusion.