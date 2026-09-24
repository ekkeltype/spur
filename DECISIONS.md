# Decisions

Where the spec was silent or ambiguous, these are the choices made (spec §0). Each aims for the simplest option that fits the design pillars (spec §1). Numbers mentioned here live in `src/sim/rules.ts`.

## Architecture

- **The Rider hosts.** The action seat's browser runs the authoritative simulation, so the Rider's movement and shooting have no network latency. Everything the Engineer does is naturally latency-tolerant: levers on a heavy train, switches thrown ahead of time. To swap seats, the other player hosts; the campaign moves with a save code.
- **60 Hz ticks** (Clew used 30). Platforming and hitscan shooting feel better at 60, and the sim is cheap. Engineer snapshots go out at 15 Hz, and the desk smooths its gauges between them.
- **Clew's infrastructure is reused**: the transport, the PeerJS layer with chunking, goodbyes and reconnects, room codes, the save helpers, the DOM helpers, toasts and hints, and the Pages workflow. Those parts are renamed but otherwise unchanged.

## The network and the train

- **The train is a span list** (rear → front) on the track graph. Moving forward extends the front and trims the rear, and moving backward does the opposite. Both ends follow the switches when they lead into a junction from its trunk, which makes shunting into a spur work naturally.
- **Trailing moves spring the switch.** A train leaving a junction by a leg the switch isn't set for passes anyway, and the switch is thrown to match, with an event. Real switches would be damaged ("run through"); a spring is kinder and simpler.
- **Scheduled trains ignore the Engineer's switches.** Loop switches are sprung for them and they keep to their timetable, so the Marey chart is exact. Only the runaway follows the switches, which is what lets the Engineer divert it.
- **The train frame.** The Rider's world is the train: x from the rear coupler to the loco's front, and y above the rails. The world scrolls past, and the loco is always on the right. `framePath()` lays the track behind, under and ahead of the train on that one axis, so hazards, scenery and flags all share it.

## Information

- **Signals are derived, not scripted.** A signal's aspect comes from its block (obstacles, other trains) and, for junction signals, from the switch the Engineer has set. Throwing a switch and asking the Rider to read the signal again is the intended puzzle.
- **The spyglass exists because a side view is narrow.** The screen shows about 35 m of track, but braking from speed takes about 200 m. The spyglass lets the Rider read signals and spot obstacles in time, at the cost of standing still on a roof.
- **What leaks, deliberately.** The Engineer's view includes the hold-up (the Engineer has a gun on them), the loss of the cargo, and the Rider's whereabouts (car, roof or not, off the train), since the Engineer could plausibly see or hear these. Gunfire reaches the Engineer as loudness only. `tests/views.test.ts` checks that nothing else leaks.
- **Scheduled trains show on the Engineer's map only within 1.5 km.** The timetable chart is the planning tool; the map shows a train only once its smoke would be in sight.
- **The water spout needs the Rider.** Lowering it is the Rider's job, on the tender with E, so a water stop is a co-op moment. It's the only use of E.
