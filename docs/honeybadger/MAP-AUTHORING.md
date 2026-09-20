# Map Authoring: First Increment

The live code now loads [the shared skirmish definition](../../shared/maps/skirmish.json) for server starts/deposits, server terrain, and client terrain. Existing coordinates, unit IDs, resources, and obstacle geometry are unchanged.

## Validate

Run `npm run validate:maps` from the repository root. To validate another candidate without installing it into the game:

```powershell
cargo run --manifest-path server/core/Cargo.toml --example validate_map -- path/to/candidate.json
```

Multiple paths are accepted. The command returns a nonzero exit code for missing files, malformed definitions, or invalid geometry. Validation does not select or publish a map.

## Current Format

- `id`: 1-64 lowercase ASCII letters, digits, or hyphens; stable content identity.
- `version`: positive integer; increase when changing an authored map.
- `size`: currently exactly 1600; the existing navigation and presentation still assume this dimension.
- `starts`: exactly four `[x, y]` hub locations, indexed by player slot. Keep four even for 1v1 to preserve the current lobby contract.
- `deposits`: 1-256 objects with unique positive `id`, `x`, `y`, and positive integer `amount`. These are still the existing ore resource, not the planned dual-currency economy.
- `terrain`: at most 256 `[left, top, width, height]` blocking rectangles.

Unknown object fields are rejected. Starts need separated hubs and clear initial worker/soldier positions. Deposits need clear footprints and separation from other deposits and hubs. Coordinates must be finite and in bounds; rectangles must have positive dimensions and remain inside the map.

Static reachability uses the existing pathfinding library and the current 40-unit grid, 12-unit mobile clearance, and 8-unit segment sampling. Starting worker exits and deposits must connect through terrain. This is conservative grid validation, not proof of faction fairness, future building access, every footprint's reachability, or flawless runtime movement.

## Limitations

Only the built-in map is currently selected. Map ID/version are not yet stored or hash-checked in match rows. Old and new clients remain compatible only because this migration preserves the exact original layout. Do not deploy changed geometry until map identity/hash negotiation and match selection are implemented.

No variable dimensions, no-build zones, distinct movement/sight/fire masks, elevation, resource kinds, or faction requirements yet. Add these with their owning gameplay rules rather than accepting fields the engine ignores.

Authoring validation lives in [maps.rs](../../server/src/maps.rs); the CLI is [validate_map.rs](../../server/core/examples/validate_map.rs). See [handoff](HANDOFF.md) for test evidence and the next task.