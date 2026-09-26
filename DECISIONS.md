# Decisions

Where the spec was silent or ambiguous, these are the choices made (spec §0). Each aims for the simplest option that fits the design pillars (spec §1). Numbers mentioned here live in `src/sim/rules.ts` or at the top of the module named.

## Architecture

- **The Rider hosts.** The action seat's browser runs the authoritative simulation, so the Rider's movement and shooting have no network latency. What the Engineer does is naturally latency-tolerant: levers on a heavy train, switches thrown ahead of time. So switching seats moves the host: see "Switching seats" below.
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

- **The spyglass exists because a side view is narrow.** The screen shows about 35 m of track, but braking from speed takes about 200 m. Since round 2 it's for the few things that must be seen far off (cattle, the barricade, the runaway, a junction signal before choosing a route). Signals are read as they pass: every stop is warned by an `approach` on the signal before, and the Engineer knows where the next signal is. Its near end is 20 m (was 60 m), so a signal the train is standing at can be checked.
- **What leaks, deliberately.** The Engineer's view includes the hold-up (the Engineer has a gun on them), the loss of the cargo, and the Rider's whereabouts (car, roof or not, off the train), since the Engineer could plausibly see or hear these. Gunfire reaches the Engineer as loudness only, at most once per 15 ticks. `tests/views.test.ts` checks that nothing else leaks.
- **The runaway's trailing moves** (if a layout gave it any) would visibly throw a switch on the Engineer's map. The campaign only gives it facing moves.
- **Scheduled trains show on the Engineer's map only within 1.5 km.** The timetable chart is the planning tool; the map shows a train only once its smoke would be in sight.
- **The water spout needs the Rider.** Lowering it is the Rider's job, on the tender with E, so a water stop is a co-op moment. It's the only use of E.
- **The cab never hears horses.** Its sound is the engine, the whistle and muffled gunfire; nothing positional about bandits.

## The Rider and the bandits

- **Standing.** You stand on a surface while any part of your 0.6 m width is on it, so at 27 m/s a forward roof-gap jump from the very edge just clears; at the wind's maximum it drops you on the platform. There's no steering in the air, only the wind.
- **Controls.** W beside a ladder grabs it rather than jumping. S at a ladder's top climbs down; S on a hatch drops you in; anywhere else it crouches.
- **Tunnels** knock off anyone whose feet are above 2.3 m inside one: roofs, the cab roof and the tender top (round 2; it used to be 3.5 m, which left the tender top safe). A low bridge's beam is 1.2 m above the roof or tender top you're on; over a gap or a platform it's above the highest roof.
- **Fords** wash off anyone whose feet are below 2.0 m in one, inside or out, the cab included: the water pours through. Bandits too, like tunnels and bridges; a bandit carrying the loot drops it where he stood. A respawn waits until the rear platform is out of the water.
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
- **Sidings run at 30 mph**, the rulebook's diverging speed, so a train that obeys a diverging-clear signal is always inside the siding's limit (they were 25 mph, which a signal-obeying train overran). Spurs are 15 mph.
- **Slower track beyond a switch is always announced.** A limit applies the moment the loco crosses onto a siding or cutoff, and entering at 1.7 times it derails the train at once. So the Ahead list gives a switch set onto slower track that track's limit ("slow down", then "brake now!"), and the map puts a speed plate on every slower leg, like the curves' plates.
- **Signals don't see cattle.** Nothing lineside can tell a herd is there, so a herd never sets a signal to stop and can stand anywhere; the Rider has to spot it. Rocks set signals to stop (that's how a junction signal gives a rockslide away). **Barricades** sit outside every signal's block; otherwise a red signal would hold the train short of something it can't clear.
- **Deadlines** are whole minutes, 18–27% over a cautious drive of the plan (`builder.estimate()`), and par is about that drive. Water is designed for firebox 2 while moving and 1 while standing.
- **Run 5** names its bandits' goals (there's no express car to rob, so no "mixed").

## Money, saves and screens

- **Payouts.** A loss pays nothing and charges no fines. A win's fines can take the total below zero, but money never drops below 0. The replay half-pay applies only to a positive subtotal, so fines are never halved.
- **Restart** uses a new seed, so the variant may change. **Continue** and **Retry** restore the train, upgrades and assists as they were at the checkpoint, and go through the briefing again. A stored checkpoint is dropped if its run or seed doesn't match, or if its state lacks a field this build needs.
- **The depot.** Either player can do everything in the depot, including picking the run and both assists; only the Rider can Start or Continue. Depot changes don't clear Ready (the briefing is the real gate). Optional cars couple in a fixed order (express, passenger, boxcar, armored, caboose); a car chosen for a bigger train shows as "no room" on a smaller run.
- **Save codes** leave out the checkpoint. Importing one replaces the whole campaign.
- **Local test mode.** Only the Rider's audio plays (one set of speakers). The Engineer's pane auto-readies. If both seats pause at once, the first pause wins.

## Round 2: after the first playtest

- **Units: mph, yards and miles**, the railroad's own, like the mileposts and the rulebook's limits. Distances under a mile are in yards (rounded: to 1 yd under 100, to 5 under 1,000, to 10 beyond), a mile and up in miles with one decimal. The sim stays metric; only text changes. Numbers quoted in briefings are rounded the same way ("about 220 yards to stop").
- **No safe place.** The tender top used to be safe from tunnels and low bridges while still in the open to shoot horsemen, so a Rider could stand there all run. Now tunnels sweep it and bridges hit it, and fords make floor level unsafe, so each hazard sends the Rider somewhere different.
- **Fords have no speed limit.** They're a Rider hazard the Engineer calls, not a driving one; at speed a ford is over in seconds. Horses wade at 5 m/s, so a ford sheds horsemen for a while.
- **The lurch** fires when the brake lever crosses into emergency, not while it's held there, at 8 m/s or more, at most every 8 s. Shying horses drop 8 m/s below the train for 2.5 s (veterans 1.5 s), so they fall back 10–20 m and must catch up. Figures thrown forward hop 4 m/s forward and 2.5 m/s up, then stagger 0.6 s; inside, on ladders and crouching they're braced. A hold-up can't lurch: the Engineer's hands are up.
- **Cattle get used to the whistle.** A blast heard from beyond the scare window (270 yd) calms the herd for 8 s after the whistle stops, renewed while it sounds, so holding the whistle down never works; the blast must begin inside 70–270 yd. The whistle draws 3 psi/s of steam, so leaning on it costs pressure too.
- **One flag.** A new flag replaces the old one.
- **Cargo cars pay** $40 (express), $30 (passenger), $30 (boxcar) each when they're optional; the contract's own cars and the armored car and caboose pay nothing. The replay half-pay applies to cargo like everything else.
- **The diverging restriction ends when the train's rear passes the junction beyond the signal** (by odometer: the distance to the junction plus the train's length), or at the next signal. Its fine is its own reason (`junction`), so the log can say what happened.
- **The balance bot heeds the Engineer's calls.** The GuardBot now gets down for tunnels, up for fords and crouches for bridges, as a sharp Rider would when the Engineer calls them; with a hazard every minute, a Rider who ignored them all would stand for a distracted player, not a sharp one. It acts 6 s before a tunnel or ford reaches it, heads for the nearest walk region at a safe height and stays until it has passed (the sooner of two hazards wins), chases bandits only within a safe region, and crouches from 1 s before a low bridge, holding S without pressing it (a press would drop it through a hatch).

### Round 2 in detail

- **The lurch fires going into emergency**: the lever from full service (0.85) or below to above it. The desk's full-service notch sends exactly 0.85, and the Ahead list's "brake now" assumes full service, so only emergency counts. The autopilot's own hard stops lurch too (once in Night Freight, when the Dry Creek signal drops as No. 7 enters the block ahead).
- **Who shies and who's thrown.** Horsemen approaching, pacing or boarding from 40 m behind the rear to 40 m past the loco shy, a getaway horse included, and a looter won't jump onto a shying horse. A second lurch keeps the longer shy. Thrown figures get 4 m/s added to their own motion and 2.5 m/s up, then the knockdown's no-control state for 0.6 s, with no heart lost and no invulnerability; in mid-air it's the shove alone. Braced: crouching as of the tick before the lurch, on a ladder, inside a car or the cab, and on the tender deck (sheltered like the cab). `thrown` fires for a shove too.
- **Hazard lines go by the feet, wherever you are.** A tunnel sweeps a ladder's upper rungs and a ford washes its low rungs. Inside a car or the cab the ceiling keeps a jump's feet under the tunnel line, but a jump from the plates between cars or from the tender deck crosses it.
- **Respawns wait** with the countdown held at 0 while the rear platform is in a ford (and, on a train with nothing behind the tender, while a tunnel is over the tender top, where the Rider comes back).
- **Horses in a ford** are held to 5 m/s at once, in every mode: the water stops them, not the reins. Pacing a train at 45 mph, a rider who wades more than 15–40 m of river falls 70 m behind and gives up, so a ford at speed sheds horsemen for good. Hazards are therefore scanned 100 m behind the train (as far back as riders are followed), and fords come at least 900 m after a wave rides in (1,350 m after an ambush), or they'd waste the wave.
- **Nobody plans a way down off the train's rear end.** Walking off the last car's rear roof always overshot the 0.5 m platform and left the train, so the navigation graph uses the ladder there.
- **Calm cattle** listen again exactly 8 s after the last sound they heard; a herd that's been hit keeps its count untouched. The whistle sounds at any pressure; its steam draw stops at 0 psi, and the governor doesn't allow for it.
- **The autopilot's whistle** never begins a blast, plan point or not, that a herd ahead would hear from beyond the window, and waits for the whistle to fall quiet before a herd's blast, since only a fresh one scatters. It blows once per herd from 140–210 m, or leaves the herd to a plan point just ahead (170 m out in runs 3 and 6), which is then the only blast. With a second herd within earshot beyond the window, it holds its blast for the near herd and pushes through it at 18 mph.
- **The junction limit's distance** is walked from the signal the way it faces, with the switches as set (the whole 2.5 km walk if the junction isn't on it). Junction fines count as speeding fines. The autopilot still keeps a diverging-clear 30 mph to the next signal, which is cautious and keeps its timings.
- **The Rider's rhythm in numbers.** Every plan passes at least 7 hazards (all six runs have 8), never two of a kind in a row without a stop between, at least 350 m apart (450 m between a tunnel and a ford, to climb between them), the first at least 700 m from the start, and on average no more than 100 s of driving per hazard. The cutoff nobody plans for (run 2's Dry Gulch) gets hazards too, so the short way isn't a way out.
- **Hazards keep clear** of station platforms (±30 m, plus the longest train standing at one), water towers (±60 m, plus the standing train), holds, signals (±40 m), switches (±60 m), trestles (±150 m) and a burning trestle's run-up, obstacles (±150 m, and the 350 m before cattle and barricades, where the Rider is at the spyglass). Content tests check every route a train can take, not just the plans. Hazards are named place and kind: "Sage Creek ford", "Horseshoe flume".
- **On the desk, the whole train counts** for the hazards to the people aboard: tunnels, fords and low bridges stay on the Ahead list ("now · clear in 75 yd") until the last car is past, because the Rider may be on it. Curves and trestles count at the loco. The calls are "get down" (tunnels), "get up top" (fords) and "duck up top" (low bridges). Junction signal rows say "Ask early. Red: the road set is blocked". A block signal's row asks what it shows as it passes, or now when the train stands within 100 m of it.
- **Precise yards.** The precision-stop readout is in whole yards; its tolerances round down (a station's 16 yd, the spout's 3 yd) so keeping inside them keeps inside the rule. A distance that would round up to 1,760 yd reads "1.0 mi". Depot weights are in (short) tons.
- **Cargo in the depot** shows full rates, with a "(half on a replay)" note on replays; the results row names the cars that earned it. The depot and the results use the sim's own `cargoCars()`.
- **Hints show on any run not yet won**, not only the first, since signals and cattle first appear in run 3; the setting reads "On runs not yet won". Each hint shows once per play screen. The Engineer's signal hint waits 9 s into a run so it doesn't replace the opening one.
- **The protocol went to version 2** (3 since switching seats). Round 2 changed what the host sends, so an Engineer on an old page is asked to reload.

## After round 2: the brakes, the fire and the hold-up

- **A lurch costs the Rider a heart** when it throws them off their feet (standing outside, not crouched). A shove in mid-air costs nothing: nothing slammed them into anything. Bandits are thrown as before but not hurt, so the slam stays a tool against boarders rather than a way to clear the roofs.
- **The fire's place is inside.** A burning trestle's flames burn everyone outside the car bodies, which makes "inside a car or the cab" a fourth refuge beside down (tunnels), up (fords) and crouched (bridges). Burns come as the flames reach you and then each time the 0.8 s of invulnerability after a hit runs out, so a crossing of 15–20 s is several hearts: effectively a place you must reach, but with time to react. Bandits burn at the same rate; a tier-1 bandit outside dies at the first burn.
- **Drawn behind the train.** The fire rises behind the cars and above the roofs, so a figure outside stands against it while a car's cut-away inside looks sheltered. A burn throws embers off the Rider and plays a flare; a toast warns at most every 5 s.
- **The outlaw at the desk** is flavour: the HANDS UP banner still explains. He rises over the timetable, which matters least while the levers are dead, sways, jabs his gun when a dead control is tried, and falls away when the cab is clear. Reduced motion stills him.
- **The balance bot gets inside** for a burning trestle as it gets down for tunnels and up for fords.

## Round 3: a faster world, and the loco's tiers

- **The world runs a quarter faster than the wall clock** (`TIME_SCALE` 1.25). The sim is untouched: still 60 ticks to a world second, so every rule, test and balance number keeps its meaning, and the host just steps 75 ticks a real second. Players count on the wall clock, so whatever shows them a duration converts at the edge: the Ahead list's ETAs and urgency, the desk hints' timing, a flag's age, the Rider's respawn count. The engine's beats and rail clicks are heard at the real pace, to match the drivers on screen; the wind and the brake squeal still follow the sim's speed, as they stand for forces the sim applies. The game clock (timetable, deadline, the contract clock) is the world's: a game minute passes in 48 real seconds. Snapshots stay at 15 a real second (every 5 ticks), so the network load is unchanged.
- **The loco's tiers: power and speed.** Power multiplies the tractive effort: quicker away, stronger up grades, and a little more top speed. Speed cuts the drag: more top speed, nothing at a crawl. So one line is for heavy trains and hills, the other for the long straights. Each tier states its whole gain over stock (the highest owned counts), so a blurb is true on its own. A whole line costs about a third of what the campaign pays ($760 for power, $650 for speed), so a pair chooses. What a faster train buys: more cargo while still outrunning boarding horsemen (48 mph), at the price of more road to stop in and curves taken at its peril. Deadlines are still set for the stock loco, so the tiers make On time easier; that's a fair reward.
- **One row per line in the shop.** Pips for the tiers owned, then only the next tier to buy (the whole line and its prices are in the row's tooltip), so a line never shows a button that can't be pressed. A refused purchase names the lowest tier missing, the one to buy now. A save holding a tier without the one below drops it (and the tiers above), which only an edited save can need.

## Switching seats

- **The host moves with the Rider's seat.** When both tick "Switch seats", the Engineer's browser opens a new room (a new code) and the Rider's browser hands it the save and joins it. Reusing the old code would race the old room's release on the signalling server. The Rider's browser leaves only once the other has left its room (it has the save by then), or after 3 s.
- **The save goes over only once the new room is open.** `switchBegin` carries nothing; the campaign, the checkpoint and the selected run go in `switchSave`, after `switchRoom`. So the seed in a checkpoint only reaches a browser that is about to become the host, not an Engineer whose room then failed to open.
- **Nothing changes unless it all works.** A room that can't open (`switchFailed`) or an Engineer dropping out before the handover leaves the seats as they were, clears both boxes (or the Engineer's) and says why in the lobby. The depot and Start wait while the seats switch. Once the save has gone, the switch goes ahead.
- **A tick and an untick can cross.** If the Engineer unticks just as the Rider ticks, the host may see both ticked and begin. The players talk; the box is a confirmation, not a lock.
- **Local test mode has no box.** One person plays both seats in one window, so switching would change nothing.
- **Both browsers keep the campaign.** The campaign used to live only in the host's browser, so after a switch the progress stayed with whoever hosted last, and the next session could start from an older copy. Now the Engineer's browser keeps a copy of every campaign the host sends, and the host takes the Engineer's copy at the hello when it's further along. "Further along" needs no clocks or ids: along one campaign, wins, medals, unlocks and purchases only grow, so containment decides; money moves both ways and isn't compared. Two different stories (neither within the other) can't be merged: the one being played wins, and the other is kept under `spur.save.aside`, never silently lost. The host never takes a campaign mid-game.
- **A mirrored campaign keeps the browser's own settings**, and drops its checkpoint when the campaign has moved on (it would be from an earlier point). Switching seats brings the Rider's checkpoint along.
- **The protocol is version 3.**

## Audio

- **The engine and the wind ignore the effects slider.** They sit on a "world" bus scaled by master only, like Clew's ambience, because the Rider judges speed by the engine.
- **`stopAll()`** silences every continuous layer but lets one-shots already playing finish, so leaving a screen doesn't cut off a crash or a stinger.
- **Extra sounds** beyond the spec's list: a bell on station arrival (both seats) and on low water (the Engineer), a thud when the train pushes through an obstacle, and cab lever clicks at most one per 180 ms.
