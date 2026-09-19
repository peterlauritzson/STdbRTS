# Game Design

Status: proposed design informed by [documented mod rules](RESEARCH.md) and [confirmed author priorities](README.md). Faction labels below are working descriptions, not final names.

## Pillars

1. Expansion creates opportunity and exposure. Cheap infrastructure should let players return to the map, not permanently fortify every resource.
2. Different economies create different vulnerabilities. Resource choice, travel, territory, production capacity, and supply must not collapse into one generic income multiplier.
3. Zones change what a player can do. Their benefits, boundaries, sources, and ways to dismantle them must be visible and meaningful.
4. Losing a fight should hurt without routinely ending the match. Refunds and accessible worker recovery compete with travel time, production, territory, and tech.
5. Players issue intentions and prepare responses. Units handle approved local tactics; players decide where, why, and under which constraints.
6. Spectacle serves readability. Distinct silhouettes, movement, hit reactions, and ability telegraphs matter more than particle volume.

## Resources and pacing

**Proposed initial model:** two spendable currencies, capacity limits, and faction-specific local constraints. Names remain provisional.

| Resource or constraint | Strategic purpose | Initial spending/availability policy |
| --- | --- | --- |
| Material | Expansion, replacement, and basic military mass | Workers/infrastructure/basic troops; widely distributed finite deposits |
| Catalyst | Technology, advanced capabilities, specialist units | Fewer contestable sources; upgrades and specialist units need both currencies |
| Supply | Army/economy opportunity cost | Includes workers; faction infrastructure supports it; not a third currency |
| Energy/charges | Local tactical availability | Unit/structure-specific regeneration and abilities; not freely transferable banked currency |
| Organic production stock | Free-worker and army production tradeoff | Local generation and capacity; free harvesters still consume stock and supply |
| Relay coverage | Strategic mobility and recovery | Destructible source-linked zones; not a currency |

The original's minerals/gas split is evidence for dual currencies, not proof that every price should be copied. A generic ore balance plus faction income bonuses would lose essential decisions. No more global currencies until these roles are distinct in playtests.

Retain finite deposits and optional rich variants. Evaluate income, travel, depletion, and build time together: lower income plus cheap bases alone does not guarantee active expansion. Opening income assistance and army-death refunds are tunable ruleset parameters, not hardcoded exceptions.

**Proposed first refund policy:** recover a fraction of the actual paid material/catalyst invested in an eligible permanent army entity. Historical reference fraction is 50%. Track eligible investment through morphs without double counting. Workers, buildings, free summons, and expired temporary units are ineligible. Cancellation and death are distinct terminal events; never both pay. Friendly/self-inflicted deaths cannot create profit. Refunds are paid once after simultaneous deaths, cannot rescue a defeated player, and do not refund supply as currency. Final percentage and eligibility need playtests.

Do not blindly double every HP value: original multipliers depended on SC2 base statistics and defenses. Tune our own time-to-kill, warnings, pursuit, and escape opportunities around the chosen delay and available autonomous responses.

## Faction identity and counterplay

| Working faction | Economic loop | Zone advantage | Recovery and risk | Required counterplay |
| --- | --- | --- | --- | --- |
| Network | Cheap fragile workers mine material without a return trip; specialist-resource throughput still needs a defined separate loop | Destructible relays enable transport and reinforcement; later mobile fields | Rapid redistribution, shield-funded recall, inexpensive replacement; relay loss cuts movement and supply | Raid scattered workers, destroy relays, threaten landing areas, force shield expenditure |
| Organic | Free small harvesters consume shared production stock; combine workers into builders; large worker counts | Living terrain supports harvesting/survival, movement, and temporary death-spawns | Rebuild labor cheaply while territory survives; new hubs provide production; losing territory can cascade | Sever sources, exploit fast decay, attack fragile hubs, use area damage against dense labor |
| Industrial | Cheap conventional labor plus autonomous outposts switching between material and catalyst | Owned sight through temporary smoke; defended extraction positions | Income suppression and burning make outposts vulnerable; mobile repair and deliberate disengage protect investment | Repeated raids suppress income without requiring demolition; flank smoke and protect detection/scouting |

No faction should be "the only one with automation." All receive the same behavior-program framework; faction abilities determine available actions.

### Network first loop

Mine away from a main base, establish a relay near a new deposit, reinforce it through the network, then decide whether to defend, recall, or concede the relay. Relay transfer needs visible source/destination conditions, a channel and arrival vulnerability, legal occupancy, and failure rules. First version uses stationary fields; mobile fields and upgrades that remove arrival penalties follow after counterplay is proven. Recall remains identity-critical but follows basic transfer because it adds interruption and a defensive resource cost.

### Organic first loop

Generate production stock, choose labor versus army, extend living ground, establish a vulnerable hub, and fight where losses spawn temporary defenders. Temporary terrain sacrifices and worker combination create expansion decisions. Test a severed territory region explicitly: decay should create a response window, not an unreadable instant mass death. Exact grace periods remain tunable. On-death children cannot recursively spawn or earn refunds.

### Industrial first loop

Take an exposed outpost, choose its output according to production plans, and protect it with scouting, smoke, repair, or mobile harassment. Define suppression from authoritative hostile damage with a fixed recovery timer; a visual attack animation alone cannot stop income. Source duration remains unresolved, so choose a labeled experimental value later. Retreat grants mobility then vulnerability; autonomous use must obey a player's retreat destination and commitment rules.

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

**Proposed victory:** surrender or loss of all completed primary command hubs, with at least one completed hub required throughout the match. Incomplete emergency sites do not prolong elimination. This replaces the prototype's one-HQ assumption and must be decided before multi-base production is balanced. Define same-tick destruction as a draw when both lose their last hub. Disconnected players retain state under the existing grace/cleanup policy; disconnect is not surrender.

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
| Refinery raids matter without demolition | Measure suppressed income, defender response, raid investment, repair burden | Tune suppression and recovery; avoid permanent harassment lockout |
| Delay plus behavior reduces required micro | Compare preset-only, customized-policy, and repeated-manual-order players on identical scenarios | Improve defaults, autonomy, warnings, or delay before adding reaction-heavy spells |
| Zone advantages are legible | Ask players to identify the source and cause of a loss from the battlefield/replay | Improve feedback and simplify stacking |

These are hypotheses, not proven balance results. Use short scripted fixtures followed by human playtests; do not mistake bot win rates for human balance. Record sample size, matchup, skill, rules version, and map for every conclusion.