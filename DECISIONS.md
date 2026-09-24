# Decisions

Where the spec was silent or ambiguous, these are the choices made (spec §0). Each aims for the simplest option that fits the design pillars (spec §1). Numbers mentioned here live in `src/sim/rules.ts` or at the top of the module named.

## Architecture

- **The Rider hosts.** The action seat's browser runs the authoritative simulation, so the Rider's movement and shooting have no network latency. What the Engineer does is naturally latency-tolerant: levers on a heavy train, switches thrown ahead of time. To swap seats, the other player hosts; the campaign moves with a save code.
- **60 Hz ticks** (Clew used 30). Platforming and hitscan shooting feel better at 60, and the sim is cheap (about 10 µs a tick for the train). Engineer snapshots go out at 15 Hz, and the desk smooths its gauges between them.
- **Clew's infrastructure is reused**: the transport, the PeerJS layer with chunking, goodbyes and reconnects, room codes, the save helpers, the DOM helpers, toasts and hints, and the Pages workflow. Those parts are renamed but otherwise unchanged.
- **Nothing on the wire carries the seed.** It picks the run's hidden variant, so the Engineer's browser never learns it.

## The network and the train

- **The train is a span list** (rear → front) on the track graph. Moving forward extends the front and trims the rear, and moving backward does the opposite. Both ends follow the switches when they lead into a junction from its trunk, which makes shunting into a spur work naturally.
- **Trailing moves spring the switch.** A train leaving a junction by a leg the switch isn't set for passes anyway, and the switch is thrown to match, with an event. Real switches would be damaged ("run through"); a spring is kinder and simpler.
- **Cars abut in the train frame.** Each car's extent includes its end platform and half the bridge plate: the outer 0.3 m of a car is half the plate, then the 0.5 m platform, so adjacent roofs are 1.6 m apart (spec §5.1). The last car has no plate behind it. Adjacent floors at different heights (1.2 and 1.3 m) are joined by a step.
- **The tender and the cab.** A short ladder on the coal bunker's front joins the tender deck to the coal top. The boiler is a wall nobody can walk past or over.
- **Grade and speed limit are read at the loco's front**, where the views read them too.
- **Tunnels** fire `tunnelEnter`/`tunnelExit` either way (backing out of one is an exit). Trestles and obstacles only count when moving forward.
- **Rocks stop the train** (`obstacleHit`, not severe, the rocks stay put): back away and take another route. A herd still scattering counts as on the line. An obstacle a train has pushed aside or smashed through (`hit`) no longer is, for the train and for signals.
- **The spout** swings back up by itself once the tender is full, so the Rider doesn't have to raise it. `waterStops` counts each lowering, plus water-column refills that actually add water.
- **The governor (and the Engineer assist)** holds about 165–178 psi without flickering between notches, drops the fire at 0 water so it can never blow the boiler, and refuses the Engineer's firebox commands ("The governor is tending the fire.").
- **Low water** warns on each downward crossing of the threshold, so it re-arms after a refill.
- **Station stops.** "Moving" means |v| ≥ 0.3 m/s. A completed stop is kept until the loco's front leaves the ±15 m window, so the train can't re-arrive at the station it just finished. The checkpoint saves on the first tick of moving off. Passengers waiting at the origin board at once, if the consist has the car they need.
- **Commands.** Lever values that aren't finite numbers are refused. Setting a switch to the position it already has is fine, with no event.

## Other trains and signals

- **Scheduled trains ignore the Engineer's switches.** Loop switches are sprung for them and they keep to their timetable, so the Marey chart is exact. Their speed is the timetable speed while moving and 0 while dwelling. A train already part-way along its route at the start appears at once; one whose rear left before the start never appears.
- **The runaway** is off the map until its trigger. Once loose it starts from rest at its start point, accelerating at `RUNAWAY_ACCEL` minus gravity on the grade, clamped to 0..`RUNAWAY_MAX` (a slope too steep holds it; it never rolls back). It follows the switches, and any end node wrecks it at any speed. It ignores obstacles and other trains. After a wreck it leaves the track.
- **Collisions** are any overlap, with no clearance margin: a train wholly in the siding is clear even right beside the switch. The results screen says how ("Met No. 7 Freight head-on", "Ran into the back of…", "…struck the train") and where (the edge's name, or the nearest station or junction).
- **Signals are derived, not scripted.** A signal's aspect comes from its block and, for junction signals, from the switch the Engineer has set. Throwing a switch and asking the Rider to read the signal again is the intended puzzle. A block ends at the next signal facing the same way, an end node (which gives no approach aspect) or `BLOCK_MAX`; look-ahead is exactly one signal. Junction signals face their junction from the trunk.
- **Passing a signal.** The aspect is read on the tick of the crossing, and several signals crossed in one tick are handled in track order. Stop is fined at once and clears any restriction. `divergeClear` restricts to 30 mph through the junction and is fined like approach. Speeding is judged on |v|, so reversing counts. Re-crossing the same signal within 3 s (`SIGNAL_DEBOUNCE_SECONDS`) is one passing.
- **Telegrams** go out at their clock time or when the loco passes their point, whichever is first, and never after the run is over.

## Information

- **The spyglass exists because a side view is narrow.** The screen shows about 35 m of track, but braking from speed takes about 200 m. The spyglass lets the Rider read signals and spot obstacles in time, at the cost of standing still on a roof.
- **What leaks, deliberately.** The Engineer's view includes the hold-up (the Engineer has a gun on them), the loss of the cargo, and the Rider's whereabouts (car, roof or not, off the train), since the Engineer could plausibly see or hear these. Gunfire reaches the Engineer as loudness only, at most once per 15 ticks. `tests/views.test.ts` checks that nothing else leaks.
- **The runaway's trailing moves** (if a layout gave it any) would visibly throw a switch on the Engineer's map. The campaign only gives it facing moves.
- **Scheduled trains show on the Engineer's map only within 1.5 km.** The timetable chart is the planning tool; the map shows a train only once its smoke would be in sight.
- **The water spout needs the Rider.** Lowering it is the Rider's job, on the tender with E, so a water stop is a co-op moment. It's the only use of E.
- **The cab never hears horses.** Its sound is the engine, the whistle and muffled gunfire; nothing positional about bandits.

## The Rider and the bandits

- **Standing.** You stand on a surface while any part of your 0.6 m width is on it, so at 27 m/s a forward roof-gap jump from the very edge just clears; at the wind's maximum it drops you on the platform. There's no steering in the air, only the wind.
- **Controls.** W beside a ladder grabs it rather than jumping. S at a ladder's top climbs down; S on a hatch drops you in; anywhere else it crouches.
- **Tunnels** knock off anyone whose feet are above 3.5 m inside one: roofs and the cab roof, and the tender top only mid-jump. A low bridge's beam is 1.2 m above the roof you're on.
- **Hurt and respawn.** Falling off always costs a heart (except in god mode). A fall from a trestle puts you down, even in god mode. You get 0.8 s of invulnerability after respawning.
- **Exposure.** You're exposed to horsemen unless inside a car or the cab: the tender deck, ladders and mid-air count as exposed. In the armored car you can shoot out and horsemen can't hit you.
- **Weapons.** Holding the trigger fires at the weapon's rate. `stats.hits` counts trigger pulls that hit anything. Switching weapons cancels a reload. Aim assist snaps the aim before spread.
- **Loot.** Recovering dropped loot resets the crack progress. Only one bandit cracks the safe at a time, and safe-goal bandits also go for dropped loot.
- **Horsemen.** The 12 s give-up clock runs while the train is faster than 18 m/s; sprinting doesn't reset it. A hit while boarding knocks a horseman back to pacing, not off his horse, and horsemen don't shoot while boarding. Mixed waves deal goals in turn (safe, cab, hunt, powder); the boss goes for the safe. Queued members of a wave, even an ambush, ride in from the rear.
- **Bandits aboard.** Any bandit in the cab holds up the Engineer. Hunters stop 8 m away once they have a clear shot, and bandits stand still while taking aim. They only plan jumps the current wind lets them make.
- **The getaway.** A looter runs to the nearest platform. A horseman already riding along (never the boss) brings the horse; otherwise one comes up from the rear, only if the train is at 18 m/s or less, and the escape itself needs the train at 18.5 m/s or less. Speed protects the payroll.
- **God mode** stops all shooting, including at the powder car.

## Balance

Tuned against `tests/balance.test.ts`: the autopilot drives while a bot Rider fights, and a sharp Rider must win every run and variant, while an idle Rider must lose every run whose cargo the bandits are after.

- **Horses are faster than the spec's first numbers**: 21 m/s (47 mph) with a 25 m/s sprint, instead of 18 and 21. At 18 m/s the autopilot's ordinary 45 mph cruise left every horseman behind, so the Rider in run 2 never saw a fight. Now shaking bandits takes a deliberate push past about 48 mph, which costs water and is limited by curves, as the pitch intended.
- **A hold-up lets the fire down.** With the Engineer's hands up nobody can tend the fire, and a long hold-up used to boil the tender dry and blow the boiler. That's a confusing way to lose to a bandit. Now it costs time and pressure instead. It can still cost the run if the train stands on the main line when a scheduled train is due.
- **The powder car** has 12 hit points and a horseman's shot hits it 40% of the time (from 8 and 60%). A few tier-3 riders used to finish it in seconds.

## The campaign

- **One railroad.** The six maps chain into one line pushing east: Juniper → Coyote Bend → Pale Rock → Mesa → Silver Flats → Tanner's Pass → Summit. Main edges run west to east, so eastbound is +1 and every signal faces +1.
- **Run 1's mail rides in a boxcar**, since the safe (and the express car) arrive in run 2.
- **Stations** sit in town terrain. Intermediate stations are checkpoints; the origin and the destination aren't. In runs 4 and 6 the station platform is on the meet siding, so the stop and the wait overlap.
- **Meets.** Hold points are about 45 m short of the siding's end, 25 m before its exit signal. Each hold's release time is computed from the timetable (the other train clears the siding + 20–30 s), so it stays right if speeds are retuned. Siding junction signals stand 320 m before the switch; route-choice junction signals 400 m before.
- **Cattle and barricades** sit outside every signal's block; otherwise a red signal would hold the train short of something it can't clear.
- **Deadlines** are whole minutes, 18–27% over a cautious drive of the plan (`builder.estimate()`), and par is about that drive. Water is designed for firebox 2 while moving and 1 while standing.
- **Run 5** names its bandits' goals (there's no express car to rob, so no "mixed").

## Money, saves and screens

- **Payouts.** A loss pays nothing and charges no fines. A win's fines can take the total below zero, but money never drops below 0. The replay half-pay applies only to a positive subtotal, so fines are never halved.
- **Restart** uses a new seed, so the variant may change. **Continue** and **Retry** restore the train, upgrades and assists as they were at the checkpoint, and go through the briefing again. A stored checkpoint is dropped if its run or seed doesn't match, or if its state lacks a field this build needs.
- **The depot.** Either player can do everything in the depot, including picking the run and both assists; only the Rider can Start or Continue. Depot changes don't clear Ready (the briefing is the real gate). Optional cars couple in a fixed order (express, passenger, boxcar, armored, caboose); a car chosen for a bigger train shows as "no room" on a smaller run.
- **Save codes** leave out the checkpoint. Importing one replaces the whole campaign.
- **Local test mode.** Only the Rider's audio plays (one set of speakers). The Engineer's pane auto-readies. If both seats pause at once, the first pause wins.

## Audio

- **The engine and the wind ignore the effects slider.** They sit on a "world" bus scaled by master only, like Clew's ambience, because the Rider judges speed by the engine.
- **`stopAll()`** silences every continuous layer but lets one-shots already playing finish, so leaving a screen doesn't cut off a crash or a stinger.
- **Extra sounds** beyond the spec's list: a bell on station arrival (both seats) and on low water (the Engineer), a thud when the train pushes through an obstacle, and cab lever clicks at most one per 180 ms.
