# Honeybadger-Inspired RTS Plan

Status: implementation started, 2026-09-19. The documents below remain the design plan; [implementation handoff](HANDOFF.md) records completed increments, validation, limitations, and the exact next action.

Reference repository: [Thalagor/honeybadger on Bitbucket](https://bitbucket.org/Thalagor/honeybadger/src/master/) (may require login). The mod's website rules are in [mod_information.html](https://bitbucket.org/Thalagor/honeybadger/src/master/information_sites/templates/mod_information.html); executable mod files are separate.

## Direction

Build an original browser RTS about contested territory, asymmetric economies, recoverable losses, and prepared unit behavior. Preserve the mod's strategic interactions, not its exact roster or the SC2 audiovisual identity. Orders deliberately take time to become active; skilled play should come primarily from planning, scouting, positioning, economy, and configuring behavior rather than rapid manual micro.

## Reading order

1. [Game design](GAME-DESIGN.md): what the game should feel like, resources, factions, zones, maps, and the first playable slice.
2. [Research ledger](RESEARCH.md): documented Honeybadger mechanics, exact historical numbers where available, source links, and uncertainties.
3. [Commands and behaviors](COMMANDS-AND-BEHAVIORS.md): delayed execution, automation, ability timing, fairness, and player feedback.
4. [Architecture and experience](ARCHITECTURE-AND-UX.md): reusable code, security, simulation, maps, graphics, controls, assets, and testing boundaries.
5. [Roadmap](ROADMAP.md): incremental deliverables, dependencies, acceptance gates, playtests, and risks.

## Confirmed with the author

- All three asymmetric economies, zone advantages, different resources for different purposes, teleport/recall, organic territory and death-spawns, refineries/smoke/harassment, and loss recovery matter.
- Exact SC2 units do not matter. Functional relationships and faction feel do.
- The website is an adequate initial design reference. Actual mod files exist elsewhere and can be retrieved later when an ambiguity matters; their absence does not block planning.
- First polished target: desktop mouse/keyboard, 1v1. Expand formats afterward.
- Keep intentional order delay. One second is an existing baseline, not an immutable target; shorter and longer values should be tested.
- Avoid making manual micro dominant. Players may configure automatic unit behavior, eventually potentially through state machines. A gameplay command-queue cap is a possible later rule, not an approved implementation requirement.

These decisions override any earlier proposal to reproduce precise unit multipliers, immediately prioritize touch parity, or port every inherited SC2 ability.

## First release-shaped goal

Three small but genuinely different factions, two purpose-built 1v1 maps, secure fog, dependable group movement, dual-resource tradeoffs, clear delayed-order feedback, useful behavior presets, and readable original 3D presentation. Start with one map and one representative loop per faction; do not wait for a complete roster to playtest.

Existing skirmish code is the starting point, not disposable scaffolding. See [current engineering record](../ENGINEERING.md) and [existing playtest notes](../PLAYTEST.md). Existing 2-4-player functionality need not be removed; the new ruleset's release gates initially cover 1v1.

## Research limits

The authenticated repository inspected is a Django information website. Its rules were read, but executable mod data and linked match videos have not been analyzed. Documentary inconsistencies and unspecified values are recorded rather than guessed. Old-version video links are research leads, not verified gameplay evidence.

The plan proposes experiments and architecture decisions; it does not claim completed security, load, balance, replay, or rendering work. Small-model agents assisted bounded interaction and architecture reviews; their suggestions were checked against the code and the author's clarified priorities.

## Next step

Continue from the [implementation handoff](HANDOFF.md). The first increment establishes validated shared map data while preserving the existing skirmish. M0 contracts and baseline measurements and M1 experiments remain incomplete; do not attempt a wholesale engine rewrite or a full SC2 roster port.