# Skirmish Playtest

Open http://127.0.0.1:5173 and choose **Practice vs AI**, or create a 2-4 player room.
Full rules and controls are in [../README.md](../README.md).

Recorded interactive sessions: [2026-09-19 practice playtest](honeybadger/PLAYTEST-2026-09-19.md), including observed behavior, UX findings, and unverified areas.

## First Session

1. Mine with workers, build a barracks, and train soldiers/scouts.
2. Pause and resume construction; assist with another worker. Cancel one site.
3. Expand with an outpost and confirm workers choose the closer drop-off.
4. Build a factory and lab. Research upgrades and field siege against turrets.
5. Attack-move through the central terrain, use hold to defend, and repair damage.
6. Destroy an opposing HQ, return to the lobby, and start another match.
7. Reload during production/research and confirm orders, army, base, and upgrades persist.

## Multiplayer Pass

- Play one 15-20 minute 2-player match, then a 4-player match with larger armies.
- Check the one-second command delay and queued orders under real network latency.
- Test a brief disconnect without surrender, then reconnect using the same profile.
- Attack an unfinished building and its builder; resume construction after damage.
- Spend resources from multiple production buildings and verify understandable rejections.
- Check terrain chokepoints, dense bases, blocked exits, and groups of 30-60 units.
- Resize between desktop and mobile; exercise the Build and Research panels.

## Record Findings

Record room ID, displayed tick, unit/building type, action, expected result, and
actual result. Screenshots help with placement and congestion bugs. Never include
guest tokens or browser storage dumps. Separate rules bugs from balance opinions.

Balance questions: are scouts useful before infantry counters arrive, can siege
break static defenses, do outposts justify their cost, and do upgrades offer a real
choice against immediate unit production? The initial numbers are tuning inputs.

## Known Boundaries

- One map/faction, no fog of war, campaign, teams, matchmaking ranking, or replay UI.
- Public match tables are not a hidden-information security model.
- AI follows fixed priorities. Browser practice needs an open tab for its decisions.
- A* routes around static terrain/buildings; unit crowding is basic separation.
- The server tick is authoritative. Under load a simulated second can take longer
  than a wall-clock second; report sustained stale-tick warnings or large ACK times.
- Automated tests cover correctness and a deterministic soak, not internet-scale
  performance, game balance, or long real-network multiplayer sessions.