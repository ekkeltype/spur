# Switch & Spur: game design and technical spec

A two-player online co-op browser game. One player, **the Rider**, fights on the roof of a speeding
frontier train. The other, **the Engineer**, drives it and dispatches it through a live rail network.
Neither can see what the other sees, so you win by talking.

This spec is the contract for v1, the first playable version. Where it's silent, choose the simplest
option that fits the pillars (§1) and record it in `DECISIONS.md`.

## 0. At a glance

| | The Rider (action seat, the host) | The Engineer (puzzle seat, joins) |
|---|---|---|
| Plays | Side-view action on the whole train: run the roofs, jump car gaps against the wind, climb, drop through hatches, fight bandits with a revolver (later a shotgun and a rifle), look ahead with a spyglass | The cab and the dispatcher's desk: throttle, brake, reverser, firebox, whistle, a schematic route map with switches, an "Ahead" list, a timetable (Marey chart), a signal rulebook, telegrams |
| Sees | The train and its surroundings: bandits, obstacles, lineside signals and their aspects, mileposts, tunnel mouths, other trains up close | The route map and everything scheduled: junctions, tunnels, low bridges, trestles, curves and speed limits, stations, water towers, signal *positions*, other trains on the timetable (and on the map when within sight) |
| Can't see | The map, the timetable, the speedometer, the gauges | Bandits, obstacles, signal *aspects*, the runaway, anything outside the cab |
| Input | Keyboard + mouse (A/D, W/Space, S, E, R, Shift/right mouse, mouse aim and click) | Mouse (levers, switches, tabs) + keyboard shortcuts |

A **run** is one journey from depot to destination, 8–15 minutes long. Six runs make up the v1
campaign (Acts I and II). Money earned from contracts buys cars and upgrades between runs.

### Notes for implementers

1. **The simulation is pure and deterministic.** `src/sim/**` has no DOM, timers, `Math.random`,
   `Date.now`, networking or rendering, and the lint enforces it. Randomness comes from the seeded
   PRNG in `src/sim/rng.ts`, whose state lives in `GameState`. The sim advances in fixed ticks
   (`TICK_HZ = 60`). Every timer is kept in ticks or seconds derived from ticks.
2. **The state is plain JSON.** `GameState` holds no Maps, classes, `undefined`-sensitive fields or
   NaN, so it can be sent, saved (checkpoints) and restored.
3. **The Rider's browser is the host.** It runs the authoritative sim. The Engineer's browser is a
   thin client that renders `EngineerView` snapshots and sends commands. `toEngineerView()` and
   `filterForEngineer()` are the only producers of what the Engineer receives, and a test enforces
   that nothing the Engineer shouldn't know leaks through them (§16).
4. **Every tunable lives in `src/sim/rules.ts`.** Numbers in this spec are starting values.
5. **Reuse Clew.** The transport, PeerJS layer, room codes, save helpers, DOM helpers, toasts and
   hints, settings store, canvas helper and Pages workflow are copied from `C:\claude\clew` and
   renamed (`clew` → `spur`, Theseus → Rider, Ariadne → Engineer).
6. Units: metres, seconds, m/s inside the sim. Everything a player reads is in one system, the
   railroad's: speeds in mph (`MPH = 2.23694` per m/s), distances in yards (`YARD = 0.9144` m)
   below a mile and in miles (`1609.34` m) from a mile up. No metres, kilometres or km/h appear in
   the game. The game clock is seconds since midnight, shown as `2:15 PM`.

## 1. Design pillars

1. **Talk or crash.** Each seat holds information the other needs *right now*: the Engineer knows a
   tunnel is coming, and the Rider knows the line ahead is blocked. The game never relays that for
   you, but gives you the tools to relay it (the whistle, spyglass flags).
2. **Your partner's choices change your game.** Speed changes the Rider's jumps and whether horsemen
   can board. The Rider's fight decides whether the Engineer's controls work (hold-ups) and whether
   the water gets taken on.
3. **Short runs with a shape.** Depot (plan together) → the line (execute and adapt) → a set piece
   or arrival (climax) → payout. Station stops are checkpoints.
4. **Readable under pressure.** Big clear silhouettes, one accent colour per meaning (red = stop or
   danger, yellow = caution, green = clear, brass = controls), and sounds that tell you what
   happened without looking.
5. **Fair failure.** Every way to lose is telegraphed first: a signal, a call, a warning sound, a gauge.

## 2. Roles and information

| Information | Rider | Engineer |
|---|---|---|
| Route map, junctions, switch states | ✗ | ✓ |
| Distance and ETA to tunnels, low bridges, trestles, curves, stations, water towers | ✗ (sees them only as they arrive, or through the spyglass) | ✓ ("Ahead" list) |
| Speed, pressure, water, throttle, brake | ✗ (feels the wind and hears the engine) | ✓ |
| Signal positions | sees the posts | ✓ on the map |
| Signal aspects (arms, lamps) | ✓ | ✗ |
| Obstacles on the line (rocks, cattle, barricades) | ✓ | ✗ |
| Fords (the river over the line) | ✓ (as they arrive) | ✓ (map, "Ahead" list) |
| Bandits (horsemen and boarded) | ✓ | ✗ (hears gunfire; knows only when held up at gunpoint) |
| Other trains, scheduled | ✗ | ✓ timetable; ✓ on the map within sight (1.5 km) |
| The runaway (unscheduled) | ✓ (spyglass) | ✗ (a telegram warns that one is loose) |
| Telegrams | ✗ | ✓ |
| The Rider's position on the train | ✓ | ✓ (which car, roof or not, and whether they're off the train) |
| The safe and payroll status | ✓ | ✗ (except a "payroll stolen" or "recovered" event) |

## 3. Session structure

1. **Title.** Host as Rider, Join as Engineer, Local test, Settings.
2. **Lobby and depot** (both players). Room code, run list (locked or unlocked, medals), a contract
   preview, the train consist (cars) and the shop (money, upgrades), plus per-seat assists. Either
   player can change the consist or buy things. Both press Ready, then the Rider presses **Start**.
   If a checkpoint exists, the lobby offers **Continue from <station>**.
   Online, each player has a **Switch seats** box. When both have ticked it, the seats swap: the
   Engineer's browser opens a new room and becomes the host (the Rider's seat always hosts, §16.1),
   the Rider's browser hands it the save (the campaign, the checkpoint and the selected run) and
   joins that room as the Engineer. Both come back to the depot in their new seats, unready and
   unticked. While the seats switch, the depot and Start wait. If the new room can't open, or the
   Engineer drops out first, nothing changes and the lobby says why.
3. **Briefing.** The run's name and flavor, the contract, and "new this time" lines for each seat,
   plus controls. Both press Ready, then a 3-2-1 countdown.
4. **The run.** The train starts stopped at the origin station. Departing a checkpoint station, after
   its dwell, saves a checkpoint.
5. **Pause.** Esc on either side. Both press Ready to resume.
6. **Results.** Arrived or failed, with a payout breakdown, medals, stats, and:
   - Next run (on a win)
   - Retry from <last station> (on a loss, when a checkpoint exists)
   - Restart run
   - Lobby

The run ends when:
- **Won:** the train stops at the destination station (§5.6) with no critical cargo lost.
- **Lost:** one of `collision` (with another train or the runaway), `derailed` (overspeed on a curve
  or limit), `obstacle` (hit one too fast), `boiler` (ran dry with the fire lit), `lootStolen` (a
  bandit escaped with critical cargo), `powder` (the powder car blew), `trestle` (too slow over a
  burning trestle), `buffers` (hit the end of a track too fast).

## 4. The world: the rail network

### 4.1 Graph

A run's network (`RunDef`) is a graph of **nodes** and **edges** (track). Edge `a→b` is direction `+1`,
`b→a` is `-1`. An edge has a length in metres, a kind (`main`, `branch`, `siding`, `spur`), a default
speed limit, a terrain (for scenery), optional schematic polyline points for the map, and `mainAt`: the
main-line distance at `a` and `b`, used to plot it on the timetable chart.

Node kinds:
- `link`: exactly two edges meet. Trains pass straight through.
- `end`: one edge. A buffer stop, or the edge of the map where scheduled trains enter and leave.
  Reaching it at more than `BUFFER_SAFE` (1.5 m/s) is a `buffers` loss; below that the train stops.
- `junction`: exactly three edges: a **trunk** and two legs, **normal** and **reverse**. The
  junction's switch is `normal` or `reverse`.
  - A **facing** move (from the trunk) goes to the leg the switch selects.
  - A **trailing** move (from a leg) always continues to the trunk. If the switch was set against it,
    the switch is thrown to that leg automatically (a spring switch) and a `switchThrown` event with
    `by: 'trailing'` is emitted.

### 4.2 Positions and spans

A point on the network is `{ edge, off }`, with `off` in metres from the edge's `a` node. The player's
train occupies a path: `spans`, a list of `{ edge, from, to }` from the rear of the train to the front
(its forward direction is from `from` to `to`, so `to < from` means it runs `b→a` there). Their lengths
add up to the train's length.

- **Moving forward by `d`** extends the front along the track (following switches at facing
  junctions) and shortens the rear by `d`.
- **Moving backward** extends the rear (following switches for the rear, which now leads) and
  shortens the front.
- The same path-walking function serves both ends, the runaway, and look-ahead queries.

### 4.3 Features

Features are flat lists in the `RunDef`, each on one edge:

| Feature | Fields | Effect |
|---|---|---|
| Tunnel | `from`, `to`, name | Anyone above floor level (feet higher than `TUNNEL_FEET_Y`, 2.3 m: the roofs, the cab roof *and the tender top*) when the portal reaches them is knocked off the train. Platforms, the tender deck, the cab floor and interiors are safe. It's dark inside. |
| Low bridge | `at` | An overhead beam, 1.2 m above the roof or tender top under it. A Rider or bandit standing on a roof or the tender top is knocked down (1 heart, 1 s stun). Crouching passes under it. |
| Ford | `from`, `to`, name | The river runs over the line. Water stands `FORD_WATER_Y` (2.0 m) deep over the rails: anyone whose feet are below it (platforms, the tender deck, the cab, interiors) is washed off the train. Only the roofs, the cab roof and the tender top are dry. Horsemen wade at `FORD_HORSE_SPEED`. Both seats see fords: the Engineer on the map, the Rider as water ahead. |
| Trestle | `from`, `to`, optional `burning: { minSpeed }` | A bridge over a gorge. Falling off the train here counts as a long fall. A burning trestle collapses if the loco's front enters it below `minSpeed` (loss: `trestle`). |
| Station | `at` (stop mark), `platform` length, name, `checkpoint` flag, optional water column | Stop here (§5.6). |
| Water tower | `at` (spout position) | Stop with the tender hatch under the spout, and the Rider lowers the spout (§5.5). |
| Curve | `from`, `to`, `limit` | Speed limit (§5.4). |
| Grade | `from`, `to`, `grade` (rise per metre, `a→b`) | Changes the train's acceleration. |
| Milepost | `at`, `mile` | Scenery for the Rider. |
| Signal | `at`, `facing`, kind `block` or `junction` (+ `junction` id) | §9. |
| Obstacle (hidden) | `at`, kind `rocks`, `cattle` or `barricade`, optional `variants` | §8. |

### 4.4 Main-line distance

Each run has a **main line**: a chain of edges from the origin to the destination. Main-line
distance is the timetable chart's vertical axis. Edges off the main line carry `mainAt` so positions
on them can be projected (a passing siding maps one-to-one onto the main line beside it, and a cutoff
maps linearly between its two junctions).

## 5. The train

### 5.1 Consist

It's always **locomotive + tender**, then up to `maxCars` cars (5 in v1) from front to back. Car
types:

| Car | Length (m) | Mass (t) | Notes |
|---|---|---|---|
| loco | 16 | 70 | Boiler in front (not walkable), cab at the rear 4.5 m (floor 1.4, roof 4.0) |
| tender | 9 | 20 | Coal top 2.8 m, walkable; water hatch 2 m from its rear; a front deck at 1.4 joins the cab |
| express | 15 | 25 | Holds **the safe** (payroll and valuables). Roof hatch. |
| passenger | 17 | 28 | Needed for passenger side jobs |
| boxcar | 13 | 24 | Freight. Roof hatch. |
| armored | 13 | 42 | Purchased. A roof parapet gives cover when crouching; gun slits let you shoot trackside targets from inside. |
| caboose | 10 | 14 | Purchased. Faster respawn (4 s instead of 6 s); heals 1 heart every 20 s while inside |
| powder | 12 | 30 | Dynamite contracts only. 12 hit points; it explodes at 0 (loss: `powder`). |

Every car except the loco and tender has a 0.5 m **end platform** at floor height (1.2 m, the
armored, boxcar and powder cars 1.3 m) at both ends, with a ladder to the roof and a doorway to the
interior. Adjacent cars' platforms are joined by a 0.6 m bridge plate at floor height, so the whole
train is walkable at floor level, but **roofs have a 1.6 m gap** that must be jumped.

Roof heights: express and passenger 4.2, boxcar and caboose 4.0 (caboose cupola 4.7 in the middle
third), armored and powder 3.9.

### 5.2 Controls (the Engineer)

| Control | Values | Notes |
|---|---|---|
| Throttle | 0–1 (8 notches in the UI) | Tractive effort |
| Brake | 0–1 (0 release, up to 0.85 service, above 0.85 emergency) | Emergency shows sparks and squeals louder |
| Reverser | forward, neutral, reverse | Can only change below 0.5 m/s |
| Firebox | 0–3 | Steam production and water use |
| Whistle | on or off (hold) | Scares cattle (§8); a signal to the Rider. Blowing draws `WHISTLE_STEAM` (3 psi/s) from the boiler |
| Switches | normal or reverse per junction | Refused while any part of a train occupies the junction's edges within 20 m of the node |

While **held up** (a bandit in the cab, §7.4), every command except the whistle is refused ("Hands
up! There's a gun on you"). The sim eases the throttle to 0 and the brake to 0.5, and the fire is let
down, so a hold-up costs time and pressure but can't boil the boiler dry.

**Slamming the brakes** (the lurch). When the brake lever goes into emergency (from `EMERGENCY_BRAKE`,
full service, or below to above it) with the train at `LURCH_MIN_SPEED` (8 m/s, 18 mph) or more, and at
most once per `LURCH_COOLDOWN_SECONDS` (8 s), the train lurches (`lurch` event, `train.lurchTick`):
- The squeal spooks the horses. Every horseman riding alongside (approach, pace or boarding, within
  `HORSE_SHY_RANGE` of either end of the train) shies for `HORSE_SHY_SECONDS` (2.5 s; tier 3 and the
  boss 1.5 s): boarding is abandoned, aim is lost, no shots, and the horse drops to `HORSE_SHY_REL`
  (8 m/s) below the train's speed, so he falls back along the train.
- Everyone standing outside on the train (a roof, the tender top, the cab roof or a platform, not
  crouching, not on a ladder, not inside) is thrown toward the loco: a hop of `LURCH_HOP_VX` forward
  and `LURCH_HOP_VY` up, then `LURCH_STAGGER_SECONDS` (0.6 s) staggered (no control, no shooting).
  Near a roof's front end that can mean dropping onto the platform. Crouching braces you.

It's the Rider's call: a horseman about to climb aboard, "Brake!", and crouch. It costs speed, and a
slower train is easier to board.

### 5.3 Motion

`a = F/m − resist − grade − brake`, in m/s², with mass in tonnes and force in kN:

- `F = TRACTIVE_MAX (60 kN) × throttle × min(1, pressure / FULL_POWER_PSI (160)) × reverser`
- `resist = ROLL (0.02) + DRAG (0.0007) × v²`, opposing motion. A light train tops out near
  27 m/s (60 mph), and a heavy one near 20 m/s (45 mph), which is slow enough for horsemen to board.
- `grade = GRAVITY × grade × (direction of travel on that edge)`, using the grade under the loco.
- `brake = brake × BRAKE_MAX (1.1 m/s²)`, opposing motion. The `airBrakes` upgrade multiplies it by 1.35.
- The train can't reverse through zero by braking. When `|v| < 0.05`, with no net force to overcome
  resistance, `v = 0`.

### 5.4 Speed limits and derailing

The limit at the loco is the lower of the edge's `speedLimit` and any curve covering the loco's
position. Above `limit × 1.15` the wheels squeal (`overspeed` event, level 1). Above `limit × 1.4` for
1.5 s, or `limit × 1.7` at once, the train derails (loss: `derailed`).

### 5.5 Boiler and water

- Firebox `f` produces `STEAM_PER_FIRE (7) × f` psi/s while there's water.
- Cylinders use `throttle × (STEAM_BASE (3) + STEAM_PER_MS (0.5) × |v|)` psi/s when the reverser isn't neutral.
- Pressure also loses 0.5 psi/s to heat loss. It's clamped to 0..`P_MAX` (200). While it sits at
  `P_MAX` with a surplus, the **safety valve** lifts (a hiss) and wastes the surplus.
- Water falls by `WATER_PER_PSI (0.02)` × steam produced. Capacity is 100 (140 with `bigTender`). The
  run's `initialWater` sets the start level.
- Below 20 water there's a low-water warning. At 0 water nothing is produced. At 0 water with the
  firebox above 0 for 6 s, the boiler explodes (loss: `boiler`). Dropping the fire to 0 prevents it.
- The `governor` upgrade (or the Engineer assist) sets the firebox automatically to hold about 175 psi.
- **Water towers:** the train is stopped (`|v| < 0.1`) with the **tender hatch** (train-frame x = 2 m
  from the tender's rear) within ±3 m of the tower's spout. The Rider, on the tender top within
  1.5 m of the hatch, presses **E** to lower the spout. Water then fills at 12/s until full. Moving
  the train raises the spout. The Engineer's "Ahead" list shows the distance from the hatch to the
  spout as the train approaches.

### 5.6 Stations

The train is **stopped at a station** when `|v| < 0.3` with the loco's front within ±15 m of the
stop mark. After `DWELL` (8 s) stopped there, the stop **completes**:
- passengers board or alight for side jobs;
- a station with a water column refills the tender to full;
- at the destination, the run is won;
- at a checkpoint station, the checkpoint is saved when the train next moves off.

Moving before completion resets the dwell.

## 6. The Rider

### 6.1 The train frame

The Rider's world is the **train frame**: x in metres from the rear coupler of the last car (x = 0)
to the loco's front (x = L, the train length), and y in metres above the rail tops. The loco is always
on the right. Scenery and trackside things are placed in this frame by their track distance: a point
`d` metres ahead of the loco's front is at `x = L + d`, and a point `d` metres behind the rear is at
`x = −d`.

### 6.2 Controls

| Key | Action |
|---|---|
| A / D | Walk toward the rear or the loco |
| W or Space | Jump. On a ladder, W climbs up. Under a hatch inside, W climbs out. |
| S | Crouch. On a hatch, drops inside. On a ladder, climbs down. |
| E | Interact: lower the water spout, pick up things |
| R | Reload |
| Q, or 1–3 | Switch weapon (weapons you own) |
| Mouse | Aim; left click fires |
| Shift or right mouse (hold) | Spyglass (§6.5) |
| Esc | Pause |

### 6.3 Movement

- Walk 4.5 m/s, crouch-walk 2.0 m/s, acceleration 35 m/s². The Rider is 1.8 m tall (1.0 crouched) and 0.6 m wide.
- Jump speed 8.2 m/s, gravity 22 m/s², which gives about 1.5 m of height and 0.75 s in the air. Ladders climb at 2.8 m/s.
- Roofs, the tender top and the cab roof are solid from above. Floors are solid. Car walls block
  horizontally, except at doorways (platform ↔ interior) and hatches.
- **Wind** (on roofs, the tender top, the cab roof and platforms; not inside, not in the cab). Let
  `w = (|v_train| / 25)²`, clamped to 1.4. Walking toward the loco (against the wind) tops out at
  `4.5 × (1 − 0.35w)`, and toward the rear at `4.5 × (1 + 0.25w)`. In the air, horizontal velocity
  gets `−2.4w` m/s² (pushing toward the rear when moving forward, the other way when reversing). At
  full speed a forward roof-gap jump barely makes it. Missing a jump drops you onto the platform
  below, which costs time but not health.
- Falling off the train (off either end, knocked off by a tunnel, washed off in a ford, or blown off
  the rear) puts the Rider **off the train**: −1 heart, respawn at the rear-most platform after
  `RESPAWN_OFF` (6 s, 4 s with a caboose). Off a trestle it's a long fall: the Rider goes **down**. A
  respawn waits while the rear platform is still in a ford.
- **No place is safe from everything.** Tunnels sweep everything above floor level, including the
  tender top; fords wash off everything below the car roofs, including interiors and the cab; low
  bridges hit anyone standing on a roof or the tender top. The Rider keeps moving: down for tunnels,
  up for fords, crouched for bridges.
- At 0 hearts the Rider is **down**: respawn at the rear after `RESPAWN_DOWN` (10 s) with full hearts.
  The run goes on without you.
- Hearts: 5 (+1 with `extraHeart`, +2 with the Rider assist). After a hit you're invulnerable for 0.8 s.

### 6.4 Weapons and shooting

Shots are hitscan from the Rider's shoulder (x, y + 1.35; 0.8 crouched), with a visible tracer.

| Weapon | Rounds | Between shots | Reload | Damage | Range | Spread |
|---|---|---|---|---|---|---|
| Revolver | 6 | 0.28 s | 1.6 s | 1 | 60 m | ±1.5° |
| Shotgun (`shotgun`) | 2 | 0.5 s | 2.2 s | 1 per pellet, 6 pellets | 18 m | ±7° |
| Rifle (`rifle`) | 8 | 0.55 s | 2.6 s | 2 | 120 m | ±0.5° |

`quickReload` makes reloads ×0.65. Reloading starts automatically on an empty fire press.

There are two layers:
- **The train layer.** The Rider and boarded bandits. Shots are blocked by car bodies: walls, roofs,
  floors. Line of sight is a ray against the train's solid rectangles.
- **The trackside layer.** Horsemen, beside the train. Shots between the layers ignore the train's
  geometry, but a Rider *inside* a car can't shoot trackside targets (and trackside bullets can't reach
  them there), except inside the armored car (gun slits).

Horses can't be hit, only their riders. The Rider assist adds aim assist: a shot within 6° of a
target snaps to it.

### 6.5 The spyglass

Hold Shift or the right mouse button while on a roof, the tender top or the cab roof (not inside,
not in a tunnel). The Rider stops. The view pans ahead of the loco to a look-ahead distance set by the
pointer's horizontal position: from `SCOPE_MIN` (20 m, so a signal the train is waiting at can be
checked) at the left edge to `SCOPE_MAX` (650 m) at the right, or 300 m at night (450 m with
`headlamp`). A left click while scoped places a **flag** at the centre of the view: a marker on the
Engineer's map at that track position. There is **one flag** (`FLAG_MAX`): a new one replaces it. It
disappears after 90 s or once the train passes it.

The spyglass is for the few things that must be seen far ahead: cattle on the line, a barricade,
the runaway, a junction signal read before choosing a route. Everyday signals are read **as the
train passes them**, straight from the line: a yellow arm or lamp means the next signal is at stop,
so the Engineer, who knows exactly where that signal is, can stop at it (§9).

### 6.6 Interactions (E)

- **Water spout:** §5.5.
- **Loot:** touching dropped loot picks it up and returns it to the safe at once (event `lootRecovered`).

## 7. Bandits

### 7.1 Waves

`WaveDef`: a trigger point (when the loco's front passes it moving forward), a count, `from: 'rear' | 'ahead'`,
a goal (`safe`, `cab`, `hunt`, `powder` or `mixed`), a tier (1–3), an optional boss, and optional
`variants`. At most 6 horsemen and 4 boarded bandits exist at once. Extra spawns wait in a queue.

- `rear`: horsemen start 45 m behind the rear and gallop up.
- `ahead`: they wait beside the track 450 m past the trigger and start galloping when the loco is
  within 60 m. They can be spotted with the spyglass.

### 7.2 Horsemen (the trackside layer)

- World speed up to `HORSE_MAX` (21 m/s, 47 mph), sprinting at up to 25 m/s for 8 s of stamina. Stamina
  refills at one third of that rate. They accelerate at 3 m/s².
- A horseman who can't keep up for 12 s, or falls 70 m behind the rear, gives up.
- In a ford a horse wades at `FORD_HORSE_SPEED` (5 m/s) at most, so a train taking a ford leaves its
  horsemen behind for a while.
- A lurch (§5.2) makes them shy.
- They move to a boarding point that suits their goal:
  - `safe`: the express car's ends.
  - `cab`: the cab's side, boarding straight into the cab.
  - `hunt`: the nearest platform to the Rider.
  - `powder`: they don't board. They pace the powder car and shoot it.
- **Boarding** needs the train at no more than `HORSE_MAX + 0.5` and the horseman within 1.2 m of the
  point for 1.4 s. A hit during boarding knocks them off.
- **Shooting:** every 2.5–4 s (tier 3: 1.8–3 s) while within 30 m of an exposed Rider (on a roof,
  platform, tender top or cab roof). The shot has a 0.6 s telegraph (tier 3: 0.45 s), a glint and a
  raised gun. Hit chance: `0.6 − 0.012 × distance`, ×0.6 if the Rider is crouched, ×0.7 if they've
  moved faster than 3 m/s in the last 0.3 s, and at least 0.08. The roll uses the sim RNG.
- Hit points: tier 1: 1, tier 2: 2, tier 3: 2, boss: 8. Only riders can be hit; horses can't.

### 7.3 Boarded bandits (the train layer)

- They use the Rider's movement physics (walk 3.8 m/s, same jump and wind) and a small navigation
  graph over the train (roofs, platforms, interiors, ladders, doorways, hatches, gap jumps, the tender
  top, the cab).
- They shoot the Rider when there's line of sight within 25 m: every 2–3.5 s, 0.5 s telegraph, hit
  chance `0.55 − 0.015 × distance` (crouch ×0.7).
- Tunnels, low bridges and fords hit them exactly as they hit the Rider (a bandit washed off in a
  ford drops any loot where he stood), and a lurch throws them like the Rider.

### 7.4 Goals

- **Safe.** Walk to the safe (the express car interior, centre) and crack it: `CRACK_TIME` 18 s (tier 3:
  14 s). Progress is kept if they're interrupted. Then take the loot and run for the nearest car-end
  platform to jump off onto a waiting horse. If they make it, the loot is **stolen**: a loss if the
  contract is critical. Shoot the carrier and the loot drops where they stood. The Rider walks over
  it to recover it.
- **Cab.** In the cab, a bandit **holds up** the Engineer until killed (§5.2).
- **Hunt.** Go after the Rider.
- **Powder.** Horsemen shoot the powder car, and each shot has a 40% chance of hitting it. At 0 HP it
  explodes.

## 8. Obstacles (hidden from the Engineer)

Obstacles are checked when the loco's front reaches them:

| Kind | Safe speed | Otherwise | Clearing |
|---|---|---|---|
| Rocks (a rockslide) | 1.5 m/s: the train stops against it | `obstacle` loss | Can't be cleared in v1: back up and take another route |
| Cattle | 10 m/s: pushed aside with a jolt | `obstacle` loss | One blast of the whistle, timed (below) |
| Barricade | 7 m/s: smashed through | `obstacle` loss | — |

An obstacle with `variants` exists only in those variants of the run (the seed picks one).

**Cattle and the whistle are about timing.** A herd hears the whistle from `WHISTLE_EARSHOT`
(700 m). A blast of at least `WHISTLE_SCARE_SECONDS` (0.5 s) while the loco is between
`WHISTLE_SCARE_MIN` and `WHISTLE_SCARE_MAX` (70–270 yards) short of them scatters them over 4 s
(`cattleScatter`). But a herd that hears the whistle from farther off gets used to it: it lifts its
heads (`cattleCalm`, `calmTicks`) and ignores the whistle until `CATTLE_CALM_SECONDS` (8 s) after the
last sound it heard. So whistling early, or holding the whistle down all the way in, leaves them
standing on the line; the blast has to begin inside the window. The Engineer can't see the herd: the
Rider spots it with the spyglass and calls "now!" (a flag on the herd gives the Engineer the distance
too). Too late, and the only way through is under 22 mph.

## 9. Signals and the rulebook

### 9.1 Aspects

| Aspect | 1-head (arm, lamp) | 2-head (upper/lower) | Rule |
|---|---|---|---|
| `stop` | arm horizontal, red | both horizontal, red over red | Stop before the signal |
| `approach` | arm up 45°, yellow | upper 45° yellow, lower horizontal red | Proceed at ≤ 20 mph (9 m/s) until the next signal |
| `clear` | arm vertical, green | upper vertical green, lower red | Proceed |
| `divergeApproach` | — | upper red, lower 45° yellow | The diverging route is set; ≤ 20 mph until the next signal |
| `divergeClear` | — | upper red, lower vertical green | The diverging route is set; proceed at ≤ 30 mph until the whole train is through the junction |

At night the arms can't be seen, only the lamps. The Engineer's rulebook shows both: arm pictures
and lamp colours with their meanings.

The Rider reads a signal **as the train passes it**; it sweeps past the whole train, so it crosses
the Rider's view wherever they are. That's enough, because every stop is warned: a signal shows
`approach` when the next one shows `stop`. The Engineer's Ahead list says when each signal is
coming ("Signal in 8 s: what does it show?"), and where the next one stands, so after a yellow the
train can stop at it. Only a signal with no signal before it (the first on a line, a junction signal
read before choosing a route) needs the spyglass.

### 9.2 How a signal decides

A signal governs trains moving in its `facing` direction. Its **block** runs from the signal to the
next signal facing the same way along the current route (following the switches as they are now), at
most 2.5 km.

- **Block signal:** `stop` if the block contains an active obstacle or any part of another train (or
  the runaway); else `approach` if the next signal shows `stop`; else `clear`.
- **Junction signal** (for the junction just beyond it): the route is whichever leg the switch
  selects. `stop` if that route's block is obstructed. Otherwise:
  - normal leg: `clear` (or `approach` if the next signal shows `stop`);
  - reverse leg: `divergeClear` (or `divergeApproach` if the next signal shows `stop`).

So throwing a switch changes what a junction signal shows. The Rider reads the new aspect, and the
Engineer learns whether that route is clear. This is the intended puzzle.

### 9.3 Rules and fines

- Passing a signal showing `stop` (loco front crossing it, moving in its facing direction): `fine`
  $50 and `redSignals++`.
- Exceeding 9 m/s (plus 10%) after passing `approach` or `divergeApproach`, before the next signal:
  `fine` $10, once per signal.
- Exceeding 13.4 m/s (plus 10%) after passing `divergeClear`, until the train's rear has passed the
  junction beyond it (or the next signal, if that comes first): `fine` $10 (reason `junction`), once.
  Past the junction the diverging track's own limit applies, as the Ahead list and map show.

The Engineer's desk never shows aspects.

## 10. Other trains

### 10.1 Scheduled trains

`AiTrainDef`: a name, kind (`freight` or `express`), length, a fixed route (a list of edges with
directions), a departure clock (when its front enters the route's start), a cruising speed, and
stops (`{ at: route distance, dwell }`). Scheduled trains:

- run to their timetable exactly: position is a pure function of the clock (constant speed with dwells);
- always use the main line through passing loops (the loop switches are sprung for them), and ignore
  the Engineer's switches;
- appear when their front enters the route and vanish when their rear leaves it;
- are **charted** on the Engineer's timetable (`charted: true`).

Any overlap between another train's occupied track and the player's train is a `collision` loss.
To let a train pass, the whole player train must be inside a siding or spur clear of its route (the
Rider can see whether the caboose is clear, and the Engineer's map draws the train's spans).

### 10.2 The runaway

`kind: 'runaway'`, uncharted. It starts at a point with a direction when the player's loco passes
its trigger, and rolls at up to 14 m/s (accelerating 0.4 m/s², faster downhill). It **follows the
switches** at facing junctions, so the Engineer can divert it into a spur, where it hits the buffers
and is wrecked (a big bang). A telegram warns the Engineer when it breaks loose. The Rider can see it
(the spyglass range applies).

## 11. The Engineer's desk

The desk is one screen at 1280×720 and up:

```
┌───────────────┬──────────────────────────────────────────────┐
│ header: clock · run name · contract · deadline · menu       │
├───────────────┼──────────────────────────────────────────────┤
│ CAB           │ ROUTE MAP (schematic, the train, switches,   │
│ speed dial    │ features, signal posts, flags, trains in     │
│ pressure dial │ sight)                                       │
│ water glass   │                                              │
│ throttle      ├───────────────────────┬──────────────────────┤
│ brake         │ TIMETABLE (Marey)     │ AHEAD (next items,   │
│ reverser      │                       │ distance and ETA)    │
│ firebox       │                       │                      │
│ whistle       │                       │                      │
├───────────────┴───────────────────────┴──────────────────────┤
│ log · telegrams · the Rider's whereabouts · RULEBOOK tab (Tab)│
└──────────────────────────────────────────────────────────────┘
```

- **Cab.**
  - Dials and levers, draggable with the mouse.
  - Held-up state: the controls grey out and "HANDS UP" shows in red.
  - Warnings: low water, overspeed, a derail warning, the safety valve.
  - Near a station or water tower, a precision-stop readout: distance to the stop mark or spout.
- **Route map.**
  - Nodes, edges and features, with the player's train drawn along its spans.
  - Switches are clickable. Each shows its state and a number for the keyboard shortcut.
  - Stations, water towers, tunnels (dark bars), low bridges, trestles (brown), curves with their
    limits, signal posts (grey), flags from the Rider (a red pennant with its age), and trains in
    sight.
  - Zoom: fit the whole run, or follow the train.
- **Ahead list.** The next 6 items along the current route (following switches): name, distance and
  ETA at the current speed. Covers tunnels, low bridges, fords, trestles, curves (with limits),
  signals, junctions (with the set leg, and that leg's limit when it's slower track), stations, water
  towers, and the end of track. A slower limit coming up says "slow down", then "brake now!" once
  service braking only just makes it. The map puts a speed plate on every slower leg beyond a switch.
  A signal's row asks the Rider to read it as it passes; a junction signal's row adds that red means
  the road the switch is set for is blocked. Fords are drawn on the map as water over the line.
- **Distances** everywhere on the desk are in yards below a mile and miles beyond; speeds in mph.
- **Timetable (Marey chart).**
  - Axes: clock across (from the run start to the deadline plus 5 minutes), main-line distance down
    (origin at the top), with stations and sidings labelled.
  - Every charted train as a line.
  - The player's trace so far (solid), and a projection at the current speed (dashed).
  - The deadline as a vertical line.
  - Predicted **conflicts**: the first crossing of the projection with another train's line that
    isn't inside a siding is marked in red. The Engineer assist adds text advice.
- **Rulebook** (the Tab key, or a button). Signal aspects (drawn day and night), speed rules, and the
  timetable as a list (trains, directions, times at stations).
- **Log.** Events for the Engineer (§16.3) and telegrams.

Keyboard shortcuts:

| Key | Action |
|---|---|
| ↑ / ↓ | Throttle a notch up or down |
| ← / → | Brake less or more |
| Space | Emergency brake |
| H | Whistle (hold) |
| F / V | Firebox up or down |
| X | Cycle the reverser (only when stopped) |
| 1–9 | Throw switch n |
| Tab | Rulebook |
| Esc | Pause |

In local test mode, only the arrows, H, 1–9 and Tab work, since the Rider has the rest of the keyboard.

## 12. Contracts, money, cars and upgrades

- **Contract** (`ContractDef`): cargo (`mail`, `payroll`, `passengers`, `dynamite`, `freight`), title,
  pay, destination station, deadline (clock), late penalty per minute, and `critical` (losing the
  cargo fails the run).
- **Side jobs:** e.g. "4 passengers Mesa → Juniper, +$80", which needs a passenger car and both stops.
- **Cargo cars pay.** Each optional express, passenger or boxcar coupled for a run carries paying
  cargo of its own (`CARGO_PAY`: express parcels $40, passenger fares $30, boxcar freight $30), paid
  on a win. Required cars carry the contract and pay nothing extra; the armored car and the caboose
  carry nothing. That's the other side of the weight trade-off: more cars pay more, but a heavier
  train is slower, late more easily, and boarded more easily.
- **Payout** on a win: pay − late penalty (never below 0) + cargo + side jobs − fines. A replayed
  run pays 50%.
- **Medals:**
  - **On time:** arrived by the deadline.
  - **Clean:** no fines.
  - **Untouched:** the safe was never cracked, the cab was never held up, and no car was lost or hurt.
- **Shop** (costs in $):

  | Item | Cost |
  |---|---|
  | shotgun | 150 |
  | rifle | 250 |
  | extraHeart | 120 |
  | quickReload | 100 |
  | airBrakes | 180 |
  | bigTender | 140 |
  | governor | 200 |
  | headlamp | 90 |
  | armored car | 220 |
  | caboose | 160 |

  Express, passenger and boxcar are always available.
- **Consist:** the run's `requiredCars` are always included. Optional cars you own can be added up to
  `maxCars`. Heavier trains are slower (§5.3), which is the trade-off.
- **Assists** (per seat, in the depot, on or off):
  - Rider: +2 hearts and aim assist.
  - Engineer: automatic firebox and conflict advice on the chart.

## 13. The v1 campaign

Act I is Iron Horse (runs 1–3). Act II is Single Track (runs 4–6).

| # | Run | New | Contract |
|---|---|---|---|
| 1 | First Light (Juniper → Coyote Bend, dawn) | Throttle and brake, station stop, tunnel, low-bridge and ford calls, a curve limit, horsemen | Mail, $120, not critical |
| 2 | Payroll to Pale Rock | A junction: the long main line with a tunnel, or the short Dry Gulch cutoff (steep, bandit ambush). The safe. Water towers and the spout. The lurch. Starts with 55 water. | Payroll, $220, critical |
| 3 | Signal Country | Block and junction signals and the rulebook. Two variants: a rockslide on one of two routes. Cattle and the whistle. Set piece: **the Devil's Trestle**, burning, crossed at ≥ 30 mph just after a 30 mph curve. | Silver, $260, critical |
| 4 | Single Track | Passing loops, the timetable chart, an opposing freight (meet at a loop), block signals protecting the single line. Side job: passengers. | Bank cash, $240, critical |
| 5 | Night Freight | Night: lamps only, a shorter spyglass. Two meets: an opposing freight and an overtaking express. Dynamite: the powder car, with horsemen shooting at it. | Dynamite, $300, critical |
| 6 | The Blackwater Line | Everything, plus **the Runaway** (divert it into the quarry spur) and the gang's boss, Black Jack Harlan (8 HP, goes for the safe). A barricade ambush. | Gold, $400, critical |

Each run also has a **plan** (`RunPlan`): the switch settings, stops and holds of a known-good
drive, and whistle points, used by the autopilot in tests (§19) and as a dev tool. Every run must be
completable by the autopilot with bandits disabled, on every variant, before the deadline, and with
some margin.

Difficulty rises through the network size, the number of simultaneous demands, wave sizes and tiers,
timetable tightness and night. Waves grow from 3 tier-1 horsemen in run 1 to 5–6 mixed-tier horsemen
plus the boss in run 6.

**The Rider's rhythm.** Every run has at least 7 track hazards for the people on the train (tunnels,
low bridges and fords), about one every minute of driving, mixing "get down" (tunnels), "get up"
(fords) and "crouch" (bridges). Fords arrive in run 1.

## 14. Tunables

All live in `src/sim/rules.ts`, grouped as simulation (`TICK_HZ`, `SNAPSHOT_HZ`, `COUNTDOWN_SECONDS`),
train, boiler, limits, stations, obstacles, signals, Rider, weapons, bandits, economy, and car
specs. The values are the numbers in this spec.

## 15. Architecture

```text
src/
  main.ts              boot and screen routing
  sim/                 pure and deterministic (lint-enforced)
    rules.ts           every tunable, car specs, the shop
    rng.ts             seeded sfc32 PRNG (copied from Clew)
    types.ts           all shared types: RunDef, GameState, inputs, commands, events, views
    network.ts         the graph index, path walking, spans, look-ahead and look-behind scans, main-line projection
    train.ts           consist layout, dynamics, boiler, limits, stations, water, obstacles, switches
    traffic.ts         scheduled trains, the runaway, collisions
    signals.ts         aspects, blocks, fines
    geometry.ts        the train frame: car rectangles, walkable surfaces, ladders, hatches, doors, the safe, the cab, navigation graph
    rider.ts           Rider movement, wind, hazards, shooting, spyglass, interactions, respawn
    bandits.ts         waves, horsemen, boarded bandits, goals, loot, the powder car
    autopilot.ts       the plan-following Engineer (tests and dev tool)
    game.ts            newGame, step, isOver, runResult, checkpoints
    views.ts           toEngineerRun, toEngineerView, filterForEngineer, trackside (for the Rider's renderer)
  content/
    runs.ts            the six RunDefs (built with builder.ts)
    builder.ts         a small DSL that turns a compact line description into nodes, edges and features
  net/                 transport, local, room, peer (from Clew); protocol, host, client (Spur)
  render/
    rider/             side view: scenery, train, figures, horses, effects, HUD
    desk/              the Engineer's cab, map, chart, ahead list and rulebook
    palette.ts         colours
    canvas.ts          HiDpiCanvas (from Clew)
  ui/                  title, lobby and depot, briefing, pause, results, settings, apps, input
  audio/sfx.ts         synthesized sounds
  save/save.ts         campaign, settings, checkpoints, save codes
tests/                 Vitest suites
```

**Tick order in `step()`:**
1. debug commands;
2. Engineer commands (or the hold-up override);
3. train dynamics: boiler, then force, then speed, then position (spans) along the track, then odometer;
4. switches thrown by trailing moves;
5. obstacles and hazards at the loco;
6. stations and water;
7. signals passed and fines;
8. scheduled trains and the runaway, then collisions;
9. wave triggers and spawns;
10. the Rider (input, physics, hazards, shooting);
11. horsemen and bandits;
12. loot, the powder car and hold-up state;
13. win and loss checks.

Every step appends `SimEvent`s.

The host renders the Rider's view from the full `GameState`, plus the `trackside()` scan of what's
around the train in train-frame coordinates, plus the tick's events (for effects).

## 16. Networking

### 16.1 Topology and rates

The Rider hosts (Clew's `PeerHost`, room id `spur-<CODE>`). The sim runs at 60 Hz. The host sends the
Engineer:
- `EngineerView` snapshots at 15 Hz;
- filtered events as they happen;
- acks for commands.

The Engineer sends commands. Continuous levers (throttle, brake) are sent at most every 50 ms, and
the last value wins. Transport, chunking, goodbyes, reconnects and TURN work exactly as in Clew
(`docs/networking.md`).

### 16.2 Messages

`hello` (with the Engineer's copy of the campaign, if their browser has one, §17), `welcome`,
`reject`, `ready`, `lobby`, `depot` (a client action in the lobby: toggle a car, buy an item, toggle
an assist), `start`, `snapshot`, `event`, `cmd`, `ack`, `pause`, `countdown`, `ping`, `pong`,
`result` and `debug` (dev only). Switching seats (§3): `switchSeats` (the Engineer ticks or unticks
the box), `switchBegin` (both have: open a room), `switchRoom` (its code) or `switchFailed`, then
`switchSave` (the save to host with). The checkpoint, and with it the seed, only crosses the wire in
`switchSave`, once the Engineer's browser is about to become the host.

`start` carries an `EngineerRun`: the `RunDef` stripped of obstacles, waves, the runaway, variants
and the plan.

### 16.3 What the Engineer receives

`EngineerView` holds:
- the tick and clock;
- the train: spans, speed, levers, pressure, water and capacity, whistle, held up, overspeed and
  derail warnings, spout, station-stop progress;
- the main-line position;
- switch states;
- charted trains in sight;
- the Rider's flags;
- the Rider's whereabouts (car index, on a roof or not, and state);
- the fines so far;
- the cargo status: `ok`, `stolen` or `recovered`. Cracking is not included.

Engineer events: `switchThrown`, `whistle`, `stationArrived`, `stationDone`, `checkpoint`,
`waterFilling`, `waterFull`, `lowWater`, `safetyValve`, `overspeed`, `fine`, `signalPassed` (no
aspect), `flagPlaced`, `telegram`, `heldUp`, `holdupEnded`, `gunfire` (intensity only, rate-limited),
`riderOff`, `riderDown`, `riderBack`, `lootStolen`, `lootRecovered`, `tunnelEnter`, `tunnelExit`,
`fordEnter`, `fordExit`, `collision`, `won` and `lost`.

A leak test checks that `EngineerView` and the filtered events never change when bandits, horsemen,
obstacles or the runaway change, apart from the documented fields (held up, loot stolen or recovered,
gunfire intensity, and the loss reason).

## 17. Saving

`localStorage`, never throwing, with an unreadable save kept aside as in Clew.

- **Host** (`spur.save.v1`), `{ version: 1, campaign, settings, checkpoint }`:
  - `campaign`: `unlocked`, `money`, `owned`, `completed[]` (run id, best time, medals, times
    completed), `assists`.
  - `checkpoint`: `null`, or `{ runId, seed, stationId, stationName, composition, upgrades, state }`,
    where `state` is the `GameState` at departure from a checkpoint station.
- **Engineer's client** (`spur.settings.v1`): their own settings. Online, the Engineer's browser
  also keeps a copy of the pair's campaign in its own `spur.save.v1` (with its own settings), so
  either player can host the next session with the campaign as it stands.
- **One campaign in two browsers.** A campaign is *within* another when every run won in it is won
  at least as often in the other, with its medals, and the other has all its unlocks and purchases
  (money isn't compared). A browser receiving the pair's campaign takes it when its own is within it,
  keeps its own when the incoming one is within its own (further along), and otherwise (a different
  story) takes it and keeps its own under `spur.save.aside`. The Engineer's browser does this with
  every campaign the host sends; the host does it once, with the Engineer's copy in their `hello`,
  taking it only when it's further along (the last session was hosted over there), and never mid-game.
  Taking a campaign that has moved on drops the browser's checkpoint, which is from an earlier point.
- **Save codes** (export and import) as in Clew.
- A checkpoint is cleared when its run is won, restarted, or another run starts.

## 18. Presentation

### 18.1 Palette

| Name | Hex | Name | Hex |
|---|---|---|---|
| Sand | `#D9B77E` | Paper | `#EFE6D2` |
| Canyon | `#B5563A` | Ink | `#2A2118` |
| Mesa | `#8E4A33` | Signal red | `#E0442E` |
| Sage | `#8A9A6B` | Signal yellow | `#F2B632` |
| Iron | `#2B2B2E` | Signal green | `#5BC46B` |
| Brass | `#C8A15A` | Lunar | `#DDE6F0` |
| Night | `#0E1428` | | |

Sky gradients: dawn (`#F6C9A0` → `#8FB3D9`), day (`#9CC7E8` → `#F2DDB0`), dusk and night.

**Type:** "Rye" (Google Fonts, Western woodtype) for titles and big numbers, and "Alegreya Sans" for
everything else.

### 18.2 The Rider's view

A full-window canvas, scaled so about 19 m of height is visible, with the rail top at 76% of the
height. The camera follows the Rider with a lead in the facing direction, and pans ahead while
scoped. Layers, back to front:
1. sky
2. far buttes and mesas (parallax 0.05)
3. mid hills, cacti and telegraph poles (0.35)
4. ground, ballast and ties (1.0)
5. trackside structures: signals, mileposts, stations, water towers, tunnel portals and mountains,
   trestles over gorges, low bridges, fords (the river over the line: the water surface is drawn in
   front of the train's lower 2 m, with spray where the cars cut through)
6. the train (the car the Rider is inside is cut away)
7. boarded bandits and the Rider
8. the foreground lane of horsemen and dust
9. effects: muzzle flashes, tracers, sparks, smoke, steam, wind streaks, tunnel darkness, night
   lighting
10. HUD: hearts, ammo, weapon, a train strip at the top (cars, the Rider, bandits aboard, safe status,
    hold-up), prompts, spyglass vignette and range, respawn countdown

Everything is drawn procedurally with Canvas 2D. There are no image assets.

### 18.3 Audio

Everything is synthesized with WebAudio (Clew's approach): the engine chuff (its rate follows
speed, its level follows throttle), rail clicks, the whistle, the bell, brake squeal, the
safety-valve hiss, the water column, revolver, shotgun and rifle shots, ricochets, hits, horse gallops,
the tunnel rumble, wind, explosions, a telegraph ticker, UI clicks, and stingers for win and loss.
Also: rushing water and splashes in a ford, the jolt of a lurch, horses whinnying as they shy, and
cattle lowing (a questioning low when they get used to the whistle, a bellow when they scatter).
The Engineer hears the cab (muffled gunfire from outside). In local test mode, only the Rider's
audio plays.

## 19. Dev tools and testing

- **Query params** (dev builds): `?local=1` (every build), `?join=CODE` (every build), `?run=N`,
  `?seed=S`, `?debug=1` (overlays: obstacles and signal aspects on the Engineer's map, bandit
  goals), `?autopilot=1` (the Engineer's pane drives itself from the run plan).
- **Debug keys** (Rider, dev): `]`/`[` for sim speed ×2/×0.5, `G` for god mode, `K` to kill all
  bandits, `N` to skip ahead 500 m.
- **Tests (Vitest):** network (walking, switches, spans, scans), train dynamics and boiler, limits and
  derailing, stations and water, obstacles, signals (aspects and fines), traffic (schedules,
  collisions, the runaway), geometry and Rider movement (jumps against wind, ladders, hatches,
  tunnels, low bridges), shooting and line of sight, bandits (spawn, pacing, boarding, cracking, loot,
  hold-up, powder), game (win and loss, checkpoints round-trip through JSON), views (the leak test),
  content (well-formedness, plus the autopilot completing every run and variant before the deadline),
  net (local pair, sessions), save, and a soak test (bots play every run for 8 simulated minutes,
  checking invariants every tick).

## 20. Milestones

1. **Scaffold:** configs, Clew infrastructure, types, rules, rng and network, with stub game and views.
   Build, lint and test pass.
2. **Simulation modules** (parallel): train, traffic, signals and autopilot; geometry, Rider and
   bandits; content (six runs); audio; the Engineer's desk.
3. **Integration:** game and views; protocol, host and client; saves; UI shell and apps; local test mode.
4. **The Rider's renderer and HUD, then playtesting and tuning** with bots and the autopilot.
5. **End-to-end checks** in a real browser (local test mode, and two browsers online), then docs and
   deploy to GitHub Pages.

## 21. Round 2: after the first playtest (2026-09-26)

The first playtest's notes, and what changed (details in the sections above; choices in
`DECISIONS.md`):

| Note | Change |
|---|---|
| Units were mixed (miles, yards, metres) | One system: mph, yards, miles (§0) |
| More interaction between the Engineer and the Rider; fool the bandits by slamming the brakes | The lurch (§5.2), cattle timing (§8), more hazard calls (§13) |
| Less spyglass; things should be seen straight from the line | Signals are read as they pass (§9.1), the spyglass reaches down to 20 m (§6.5); it's kept for a few far-off things |
| One flag is enough | `FLAG_MAX` 1 (§6.5) |
| The Rider could camp on the tender; more times to get down, and times to get up | Tunnels sweep the tender top, low bridges hit it, fords wash off everything below the roofs (§4.3, §6.3); more hazards per run (§13) |
| Cattle: holding the whistle down worked | Herds get used to an early whistle; the whistle costs steam (§5.2, §8) |
| Extra cars earned nothing | Cargo cars pay (§12) |
| The 30 mph diverging limit lasted to the next signal | It ends once the train is through the junction (§9.3) |
| Switching seats meant hosting afresh and moving a save code | A **Switch seats** box in the lobby for both players (§3); both browsers keep the campaign (§17) |

## 22. Out of scope for v1

Act III (fog runs with mileposts, coded telegrams with the Rider's cipher wheel, the gang's armored
train duel, the Golden Spike finale), uncoupling and recoupling cars, fires on cars, dynamite thrown
by bandits, interlocking lever-frame towers, contracts chosen from a board, gamepads, mobile.
