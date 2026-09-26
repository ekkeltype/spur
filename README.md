# Switch & Spur

A two-player online co-op browser game. **The Rider** fights bandits on the roof of a speeding 1880s frontier train. **The Engineer** drives it and dispatches it through a live rail network. The Engineer can see the map, the timetable and every tunnel coming, but not the bandits, the rockslide ahead or what the signals say. The Rider sees all of that, but not the map. You win by talking.

**Play it at https://ekkeltype.github.io/spur/**, published from https://github.com/ekkeltype/spur by the workflow below.

Use your own voice chat (Discord or similar). Desktop browsers, 1280×720 and up. The Rider plays with the keyboard and mouse, the Engineer with the mouse (plus keyboard shortcuts).

The full design is in [`spur-spec.md`](spur-spec.md). Choices made where the spec was silent are in [`DECISIONS.md`](DECISIONS.md).

## Playing

1. **The Rider** opens the game and chooses **Host as Rider**. The lobby shows a five-character room code.
2. **The Engineer** opens the same URL, chooses **Join as Engineer** and types the code.
3. In the depot, pick a run, couple the cars you want (an extra express, passenger car or boxcar carries paying cargo, but a heavier train is slower), spend your earnings in the shop, and both press **Ready**. The Rider presses **Start**. Read the briefing, press Ready again, and go.

To switch seats, both players tick **Switch seats** in the depot: the Engineer becomes the Rider (and hosts), the Rider becomes the Engineer, and the campaign goes with you. Both browsers keep a copy of the campaign, so either of you can host the next session.

Each run has the same shape:

- **Beginning: the depot.** Plan together: the contract, the consist, the route.
- **Middle: the line.** Drive, fight, call things out. Station stops are checkpoints.
- **End: arrival, or a set piece.** Stop at the destination with the cargo safe.

A run is lost by:
- a wreck: meeting another train, derailing on a curve, hitting an obstacle too fast, or a burning trestle collapsing;
- the boiler running dry with the fire lit;
- losing critical cargo to the bandits.

After a loss you can retry from the last station.

The v1 campaign is six runs in two acts: *First Light*, *Payroll to Pale Rock*, *Signal Country*, *Single Track*, *Night Freight* and *The Blackwater Line*. Contracts and cargo pay money, which buys guns, gear, cars and upgrades, among them two lines of locomotive tiers: power (pulls harder) and speed (runs faster), each tier bought after the one below it.

Nowhere on the train is safe from everything. Tunnels sweep everyone above the car floors off the train, fords wash off everyone below the roofs, low bridges knock down anyone standing on a roof or the tender top, and a burning trestle burns anyone outside the cars. The Engineer sees them coming and calls them; the Rider gets down, gets up or crouches. Speeds are in mph and distances in yards and miles.

### Controls

| The Rider | |
|---|---|
| A / D | Walk toward the rear / toward the loco |
| W or Space | Jump. On a ladder, W climbs; under a hatch, W climbs out |
| S | Crouch: duck under low bridges, brace when the brakes are slammed (standing, the lurch costs a heart). On a hatch, drop inside; on a ladder, climb down |
| Mouse, left click | Aim and fire |
| R | Reload |
| Q, or 1–3 | Switch weapon (revolver, coach gun, rifle, once bought) |
| Shift or right mouse (hold) | Spyglass: look far down the line when a **!** shows at the edge of the view (cattle, a barricade, a runaway, riders in wait, a red signal). Move the pointer right to look farther; click to plant a flag on the Engineer's map (one at a time). Signals you read as the train passes them |
| E | On the tender by the hatch, at a water tower: lower the spout |
| Esc | Pause |

| The Engineer | |
|---|---|
| Drag the levers, or ↑ / ↓ | Throttle |
| ← / → | Brake less / more |
| Space | Emergency brake. Slammed on at speed it spooks the horses alongside and throws anyone standing outside: the Rider calls for it and crouches |
| H (hold), or the Whistle button | Whistle: tells the Rider something's coming, and scares cattle off the line if you time it (one blast, 70–270 yards out, when the Rider calls it; blow too early and they get used to it). It uses steam |
| F / V | Firebox up / down |
| X | Reverser (only when stopped) |
| Click a switch on the map, or 1–9 | Throw it |
| Tab | The rulebook: what the signals mean, and the timetable |
| Esc | Pause |

**Local test** on the title screen shows both seats side by side in one window, over the real host and client code with an in-memory transport. It's meant for development and solo testing.

## Running it

Needs Node 22.12 or later (developed on Node 24).

```sh
npm install
npm run dev        # http://localhost:5173, or /?local=1 for local test mode
npm test           # Vitest: the sim, the campaign driven end to end, the protocol, saves, a soak test
npm run lint
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

### Dev tools (dev builds only)

Query parameters:

- `?local=1` opens local test mode, and `?join=CODE` pre-fills the join screen. Both also work in production builds.
- `?run=N` (1–6, or a run id) and `?seed=S` force the next run started, and with it the variant.
- `?debug=1` adds overlays: on the Engineer's map, the hidden obstacles and every signal's aspect; in the Rider's view, each bandit's goal and mode, and the sim's state line.
- `?autopilot=1` lets the plan-following autopilot drive the train, so one person can play the Rider's side.

Debug keys (the Rider's keyboard):

| Key | Effect |
|---|---|
| `]` / `[` | Sim speed ×2 / ×0.5 |
| `G` | God mode |
| `K` | Kill every bandit |
| `N` | Skip 500 m down the line |

Dev-only pages: `/rider.html` (the Rider's renderer with staged scenes), `/desk.html` (the Engineer's desk against a fake train), `/sfx.html` (every sound).

### Tuning

Every number is in [`src/sim/rules.ts`](src/sim/rules.ts). The runs are authored in [`src/content/runs.ts`](src/content/runs.ts) with the small layout language in [`src/content/builder.ts`](src/content/builder.ts). `tests/content.test.ts` checks every meet, deadline and water stop, and `tests/campaign.test.ts` has the autopilot drive every run and variant to the destination before its deadline.

## Deploying

`npm run build` produces a static `dist/` built with `base: './'`, so it works under any sub-path: GitHub Pages, Netlify, itch.io. Both players open the same URL.

`.github/workflows/pages.yml` lints, tests, builds and publishes to GitHub Pages on every push to `main` (Pages → Source: GitHub Actions).

## Online play, and when it won't connect

The two browsers talk directly over WebRTC (PeerJS). The public PeerJS server only introduces them. If some networks can't connect, add a TURN server or self-host the PeerServer with Vite environment variables at build time. Everything is explained in [`docs/networking.md`](docs/networking.md).

## How it's built

TypeScript (strict), Vite, Canvas 2D, PeerJS and Vitest. There's no game engine, no UI framework and no asset files: everything is drawn procedurally and the audio is synthesized with WebAudio. The architecture and much of the infrastructure follow the sibling game [Clew](https://github.com/ekkeltype/clew).

```text
src/
  main.ts            boot and screen routing
  sim/               pure and deterministic: no DOM, timers, Math.random or networking (lint-enforced)
    rules.ts         every tunable, car specs, the shop
    types.ts         shared types: runs, state, inputs, commands, events, views
    network.ts       the track graph, path walking with switches, the train's spans, the train frame
    schedule.ts      timetable math for scheduled trains
    train.ts         the consist, the Engineer's commands, boiler, motion, limits, stations, water, obstacles
    traffic.ts       scheduled trains, the runaway, collisions, telegrams
    signals.ts       aspects from blocks and switches, passing, fines
    geometry.ts      the train as walkable geometry, and the bandits' navigation graph
    body.ts          figure physics shared by the Rider and the bandits
    rider.ts         the Rider: movement, wind, hazards, shooting, spyglass, respawn
    bandits.ts       waves, horsemen, boarded bandits, the safe, hold-ups, the powder car
    autopilot.ts     a plan-following Engineer (tests and a dev mode)
    game.ts          newGame, step (the tick order), results
    views.ts         what the Engineer receives, and the trackside scan for the Rider's view
  content/           the six runs and the builder they're written in
  net/               transports (in-memory and PeerJS), room codes, protocol, host and client sessions
  render/rider/      the Rider's side view: scenery, train, figures, horses, effects, HUD
  render/desk/       the Engineer's desk: cab, route map, timetable, ahead list, rulebook
  ui/                title, depot, briefing, pause, results, settings, input, the two apps
  audio/sfx.ts       synthesized sounds
  save/save.ts       campaign, settings, checkpoints, save codes
tests/               Vitest suites
```

The Rider's browser is the host. It runs the authoritative simulation at 60 ticks to a second of the world, and the world runs a quarter faster than the wall clock (`TIME_SCALE`); what shows a player a duration counts real seconds. It sends the Engineer only their view: 15 snapshots a second, plus filtered events. `toEngineerView()` and `filterForEngineer()` are the only producers of what the Engineer receives, and `tests/views.test.ts` checks that bandits, obstacles, signal aspects and the runaway never leak into it.
