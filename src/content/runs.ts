// The v1 campaign (spec §13): Act I, Iron Horse (runs 1–3), and Act II, Single Track (runs 4–6).
// Each run picks up where the last one left off, so the six maps read as one railroad pushing east:
// Juniper → Coyote Bend → Pale Rock → Mesa → Silver Flats → Tanner's Pass → Summit.
//
// Lines are laid out with builder.ts in main-line metres from each map's west end (0). Timetables
// are designed against builder.estimate(), a deliberately cautious drive of each plan; the numbers in
// the comments come from it, and tests/content.test.ts checks every meet, deadline and water stop.
// Every run's plan is a known-good drive for the autopilot (spec §13, §19).
//
// The Rider's rhythm (spec §13): every planned route passes at least seven track hazards, about one
// a minute, mixing tunnels (get down), fords (get up) and low bridges (crouch), and two of a kind in
// a row only with a stop between them. They keep clear of platforms, towers, signals, switches,
// trestles, obstacles and anywhere the train stands, and 350 m apart (450 m between a tunnel and a
// ford, to climb between them); fords lie in river country. The content tests check all of it.

import type { AiTrainDef, RunDef } from '../sim/types';
import { clock, Line, makeRun } from './builder';

/** A hold's release: `margin` seconds after `t`, rounded up to 5 s so the timetable reads cleanly. */
const after = (t: number, margin: number): number => Math.ceil((t + margin) / 5) * 5;

/** "3:08 PM", for telegrams. */
function clockText(c: number): string {
  const h = Math.floor(c / 3600) % 24;
  const m = Math.floor((c % 3600) / 60);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------------------------------------
// 1. First Light: Juniper → Coyote Bend, at dawn. Throttle and brake, a station stop, calls for
// tunnels, low bridges and the first ford (Sage Creek, just out of the station stop), a curve
// limit, and the first horsemen. About 9 minutes.
// ---------------------------------------------------------------------------------------------

function firstLight(): RunDef {
  const line = new Line({
    length: 10400,
    speed: 25,
    ends: ['To Cedar Flats', 'To Pale Rock'],
    terrain: [
      [0, 'town'],
      [1000, 'desert'],
      [2600, 'hills'],
      [4300, 'town'],
      // Sage Creek runs shallow over the line east of town, then drops into the gorge the trestle spans.
      [5000, 'river'],
      [6000, 'canyon'],
      [7800, 'mesa'],
      [9200, 'town'],
    ],
  });
  return makeRun(line, {
    id: 'first-light',
    index: 0,
    act: 1,
    name: 'First Light',
    flavor: 'Sunup over Juniper, and the Coyote Bend mail is aboard. A few saddle tramps have been seen along the line: nothing a steady hand on the throttle and a steady eye on the roof can’t handle.',
    briefing: {
      rider: [
        'Horsemen gallop up from behind. Shoot the riders (the horses can’t be hit) before they climb aboard.',
        'A tunnel sweeps off anyone above the car floors, the tender top too: get down onto a platform or inside a car. A ford washes off anyone below the roofs: get up on a roof or the tender top.',
        'Crouch (S) for the low bridges: standing on a roof or the tender top, the beam knocks you flat.',
        'Hold Shift or the right mouse button for the spyglass to look far down the line; a click plants a flag on the Engineer’s map.',
      ],
      engineer: [
        'Ease the throttle up and brake early: from full speed she needs about 220 yards to stop.',
        'Call the tunnels, low bridges and fords: the Rider can’t see them coming. The Ahead list says how far off they are.',
        'Keep to 28 mph through Horseshoe Bend, or she leaves the rails.',
        'Stop at Sage Creek with the loco on the mark; the water column fills the tender while you stand.',
      ],
    },
    startClock: clock(5, 40),
    night: false,
    stations: [
      line.station('juniper', 'Juniper', 600, { platform: 110 }),
      line.station('sage-creek', 'Sage Creek', 4800, { platform: 90, checkpoint: true, water: true }),
      line.station('coyote-bend', 'Coyote Bend', 9700, { platform: 110 }),
    ],
    // Crouch, down, crouch; the stop; then up for the ford, crouch, down, crouch, down.
    tunnels: [
      line.tunnel('rattlesnake-tunnel', 'Rattlesnake Tunnel', [3000, 3280]),
      line.tunnel('coyote-tunnel', 'Coyote Tunnel', [7300, 7520]),
      line.tunnel('lookout-tunnel', 'Lookout Tunnel', [8800, 8950]),
    ],
    lowBridges: [
      line.lowBridge('juniper-bridge', 1900, 'Juniper wagon bridge'),
      line.lowBridge('sage-hill-bridge', 3900, 'Sage Hill stock bridge'),
      line.lowBridge('horseshoe-flume', 6200, 'Horseshoe flume'),
      line.lowBridge('stage-road-bridge', 8300, 'Stage road bridge'),
    ],
    fords: [line.ford('sage-creek-ford', 'Sage Creek ford', [5100, 5200])],
    trestles: [line.trestle('sage-creek-trestle', 'Sage Creek Trestle', [5600, 5760])],
    curves: [line.curve('horseshoe-bend', [6500, 6900], 12.5)],
    grades: [line.grade([2700, 3000], 0.008), line.grade([3280, 4200], -0.006), line.grade([6000, 6500], 0.005)],
    // Small bands of saddle tramps, one every minute or two of driving, mostly riding up behind us
    // out of the tunnels and off the trestle, and a last pair waiting past Lookout Tunnel.
    waves: [
      line.wave('first-riders', 2200, 2, 'rear', 'hunt', 1),
      line.wave('sage-hill-riders', 3550, 2, 'rear', 'hunt', 1),
      line.wave('creek-riders', 5900, 3, 'rear', 'hunt', 1),
      line.wave('coyote-riders', 7650, 2, 'rear', 'hunt', 1),
      line.wave('bend-riders', 8600, 2, 'ahead', 'hunt', 1),
    ],
    telegrams: [
      line.telegram('mail', { clock: clock(5, 40, 5) }, 'COYOTE BEND POSTMASTER WAITING ON THE MAIL. RIDERS SEEN NEAR THE RATTLESNAKE HILLS.'),
      line.telegram('high-water', 4300, 'SAGE CREEK OVER THE LINE AT THE FORD EAST OF TOWN. WATER ABOVE THE CAR FLOORS.'),
    ],
    contract: { cargo: 'mail', title: 'Mail sacks for Coyote Bend', pay: 120, destination: 'coyote-bend', deadline: clock(5, 52), latePenaltyPerMin: 10, critical: false },
    origin: 'juniper',
    initialWater: 100,
    variants: ['main'],
    requiredCars: ['boxcar'],
    par: 570,
    plan: {
      main: { cruise: 20, switches: [], stops: ['sage-creek', 'coyote-bend'], holds: [], whistles: [], minSpeeds: [] },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Payroll to Pale Rock: a junction (the long main line through Horsethief Tunnel and two fords,
// or the short, steep Dry Gulch cutoff with an ambush), the safe, water towers and the spout, the
// lurch, the first cattle and the whistle, and only half a tender to start with. About 11 minutes
// the long way.
// ---------------------------------------------------------------------------------------------

function payroll(): RunDef {
  const line = new Line({
    length: 12000,
    speed: 25,
    ends: ['To Juniper', 'To Buzzard Rock'],
    terrain: [
      [0, 'town'],
      [900, 'desert'],
      [2400, 'hills'],
      [3500, 'river'],
      [3800, 'hills'],
      [4400, 'mesa'],
      [5900, 'town'],
      [6700, 'river'],
      [7000, 'canyon'],
      [9500, 'desert'],
      [10400, 'town'],
    ],
    cutoffs: [
      {
        id: 'gulch',
        name: 'Dry Gulch cutoff',
        from: 3000,
        to: 9000,
        speed: 16,
        parts: [
          [1500, 'canyon'],
          [800, 'canyon'],
          [1300, 'canyon'],
        ],
        junctions: ['Dry Gulch Jct.', 'Gulch East Jct.'],
        side: -1,
      },
    ],
  });
  // One blast for the herd as the loco passes 170 m short of it (spec §8). It grazes the last
  // stretch before Pale Rock, which both ways share, so every crew meets it.
  const whistles = [line.at(9380)];
  return makeRun(line, {
    id: 'payroll',
    index: 1,
    act: 1,
    name: 'Payroll to Pale Rock',
    flavor: 'The Pale Rock miners haven’t been paid in a month and they’re in an ugly mood. Their payroll rides in the express car’s safe, and every road agent in the territory knows it.',
    briefing: {
      rider: [
        'The payroll is in the express car’s safe. A bandit who gets inside will crack it and run for his horse: shoot the one carrying the loot, then walk over it to pick it up.',
        'A horseman about to climb aboard? Crouch, then shout for the brake: a hard stop spooks the horses, and throws anyone standing, which costs a heart.',
        'At a water tower, stand on the tender by the hatch and press E to lower the spout.',
        'Cattle on the line? Watch the herd through the spyglass and call the moment for one blast, inside about 270 yards: whistle any sooner and they get used to it.',
      ],
      engineer: [
        'You start with half a tender. Stop at Coyote tank with the tender’s hatch under the spout (the Ahead list counts down the distance), and never let the water run out with the fire lit: the boiler blows.',
        'At Dry Gulch Jct. choose: the long main line through Horsethief Tunnel, or the short, steep cutoff where a heavy train crawls and riders lie in wait.',
        'When the Rider calls for the brake, slam it on (Space) and the horses shy off. Warn the Rider first, and get her going again after.',
        'For cattle, blow the whistle (H) once when the Rider calls it, not held down: a herd that hears it too soon gets used to it.',
      ],
    },
    startClock: clock(9, 0),
    night: false,
    stations: [
      line.station('coyote-bend', 'Coyote Bend', 500, { platform: 110 }),
      line.station('table-rock', 'Table Rock', 6300, { platform: 90, checkpoint: true, water: true }),
      line.station('pale-rock', 'Pale Rock', 10900, { platform: 110 }),
    ],
    waterTowers: [line.tower('coyote-tank', 1900, 'Coyote tank'), line.tower('gulch-tank', ['gulch', 1900], 'Gulch tank')],
    // The long way: crouch, down, up, down, crouch, the stop, up, down, crouch. The gulch has a flume
    // and a tunnel of its own.
    tunnels: [
      line.tunnel('pinto-tunnel', 'Pinto Hill Tunnel', [2450, 2700]),
      line.tunnel('horsethief-tunnel', 'Horsethief Tunnel', [5100, 5420]),
      line.tunnel('echo-tunnel', 'Echo Canyon Tunnel', [8200, 8450]),
      line.tunnel('gulch-tunnel', 'Gulch Tunnel', ['gulch', 2320, 2470]),
    ],
    lowBridges: [
      line.lowBridge('coyote-road-bridge', 1300, 'Coyote road bridge'),
      line.lowBridge('table-rock-bridge', 5950, 'Table Rock road bridge'),
      line.lowBridge('miners-bridge', 9900, 'Miners’ road bridge'),
      line.lowBridge('gulch-flume', ['gulch', 400], 'Dry Gulch flume'),
    ],
    fords: [line.ford('willow-creek-ford', 'Willow Creek ford', [3600, 3700]), line.ford('chalk-creek-ford', 'Chalk Creek ford', [6800, 6900])],
    curves: [line.curve('table-rock-curve', [7400, 7800], 14), line.curve('gulch-bend', ['gulch', 2500, 2800], 12)],
    grades: [line.grade(['gulch', 0, 1500], 0.018), line.grade(['gulch', 2300, 3600], -0.016), line.grade([4400, 5100], 0.006)],
    obstacles: [line.obstacle('pale-rock-herd', 'cattle', 9550)],
    // The long way meets more riders but mostly green ones, and an ambush waiting at Table Rock;
    // the gulch keeps its ambush and a chase down the grade, all seasoned men.
    waves: [
      line.wave('tank-riders', 2300, 3, 'rear', 'safe', 1),
      line.wave('tunnel-riders', 4500, 3, 'rear', 'hunt', 1),
      line.wave('table-rock-ambush', 5380, 3, 'ahead', 'safe', 1),
      line.wave('gulch-ambush', ['gulch', 700], 4, 'ahead', 'safe', 2),
      line.wave('gulch-riders', ['gulch', 2600], 3, 'rear', 'safe', 2),
      line.wave('echo-riders', 7900, 3, 'rear', 'hunt', 2),
      line.wave('pale-rock-riders', 9600, 3, 'rear', 'safe', 2),
    ],
    telegrams: [
      line.telegram('payroll', { clock: clock(9, 0, 5) }, 'PAYROLL ABOARD. PALE ROCK MINE SUPERINTENDENT WAITING. TAKE ON WATER AT COYOTE TANK.'),
      line.telegram('gulch', 2600, 'RIDERS SEEN IN DRY GULCH THIS MORNING. MAIN LINE LONGER BUT QUIETER.'),
    ],
    contract: { cargo: 'payroll', title: 'Payroll for the Pale Rock mine', pay: 220, destination: 'pale-rock', deadline: clock(9, 14), latePenaltyPerMin: 15, critical: true },
    origin: 'coyote-bend',
    initialWater: 55,
    variants: ['main'],
    requiredCars: ['express'],
    par: 690,
    plan: {
      main: { cruise: 20, switches: [], stops: ['coyote-tank', 'table-rock', 'pale-rock'], holds: [], whistles, minSpeeds: [] },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Signal Country: block and junction signals and the rulebook; a rockslide on one of the two
// routes past Buzzard Rock (variant A: the main line through Red Cut, B: the Lone Pine loop), which
// the junction signal gives away; three herds on the line; and the burning Devil's Trestle, crossed
// at 30 mph or better just after the 30 mph Devil's Elbow. About 13 minutes.
// ---------------------------------------------------------------------------------------------

function signalCountry(): RunDef {
  const line = new Line({
    length: 13000,
    speed: 25,
    ends: ['To Dry Gulch', 'To Mesa yard'],
    terrain: [
      [0, 'town'],
      [900, 'desert'],
      [3000, 'hills'],
      [6900, 'town'],
      [7620, 'river'],
      [7800, 'hills'],
      [9600, 'canyon'],
      [9800, 'river'],
      [10500, 'canyon'],
      [11600, 'town'],
    ],
    cutoffs: [
      {
        id: 'lone-pine',
        name: 'Lone Pine loop',
        from: 3600,
        to: 6400,
        speed: 18,
        parts: [
          [1600, 'mesa'],
          [1600, 'hills'],
        ],
        junctions: ['Buzzard Rock Jct.', 'Lone Pine Jct.'],
        side: 1,
      },
    ],
  });
  const buzzard = line.junction('lone-pine', 'w');
  const stops = ['buzzard-tank', 'cedar-wash', 'mesa'];
  // One blast for each herd as the loco passes 170 m short of it: well inside the scare window
  // (70–270 yards), and heard by no herd from farther off, so none gets used to it (spec §8). The
  // herds stand miles apart, past Pale Rock, outside Cedar Wash and outside Mesa, on both ways.
  const whistles = [line.at(1930), line.at(6680), line.at(11530)];
  // Out of Devil's Elbow at 30 mph, then open her up down the grade: the trestle wants 30 mph or more.
  const minSpeeds = [{ from: line.at(9400), speed: 15.5 }];
  return makeRun(line, {
    id: 'signal-country',
    index: 2,
    act: 1,
    name: 'Signal Country',
    flavor: 'The Mesa line is signal country now: a semaphore on every block, and a rockslide reported somewhere past Buzzard Rock. Beyond it, the Devil’s Trestle is burning, and the silver won’t wait.',
    briefing: {
      rider: [
        'Read each signal as it goes by and call it out: arm up and green is clear, 45° and yellow means the next one is at stop, level and red is stop.',
        'At Buzzard Rock the junction signal tells which way the rockslide is: scope it before the switch. Red means that route is blocked: say so, and read it again after the Engineer throws the switch.',
        'The Devil’s Trestle is burning: the flames burn anyone outside the cars. Get inside a car or the cab before we cross.',
      ],
      engineer: [
        'Signals are grey posts on your map; only the Rider can see what they show (Tab for the rulebook). After a yellow, hold 20 mph and stop at the next signal: the Ahead list shows exactly where.',
        'Set Buzzard Rock Jct. early and ask what its signal shows. If it’s red, that route is blocked: throw the switch and ask again.',
        'Take the 30 mph Devil’s Elbow at 30, then open her up: cross the burning trestle any slower than 30 and it comes down under you. Get the Rider inside first.',
      ],
    },
    startClock: clock(12, 30),
    night: false,
    stations: [
      line.station('pale-rock', 'Pale Rock', 500, { platform: 110 }),
      line.station('cedar-wash', 'Cedar Wash', 7300, { platform: 90, checkpoint: true, water: true }),
      line.station('mesa', 'Mesa', 12300, { platform: 120 }),
    ],
    waterTowers: [line.tower('buzzard-tank', 2950, 'Buzzard tank')],
    // Nothing between the tank and the switch, so the junction signal can be scoped; either way past
    // Buzzard Rock is down, crouch, down. Then the stop, up at Cedar Wash, down, the run-up and the
    // trestle, up at Mesa Creek and crouch.
    tunnels: [
      line.tunnel('buzzard-tunnel', 'Buzzard Tunnel', [3900, 4150]),
      line.tunnel('owl-hill-tunnel', 'Owl Hill Tunnel', [5700, 5950]),
      line.tunnel('lone-pine-tunnel', 'Lone Pine Tunnel', ['lone-pine', 400, 600]),
      line.tunnel('hogback-tunnel', 'Hogback Tunnel', ['lone-pine', 2450, 2650]),
      line.tunnel('cedar-tunnel', 'Cedar Tunnel', [8200, 8450]),
    ],
    lowBridges: [
      line.lowBridge('buzzard-bridge', 2450, 'Buzzard Rock stock bridge'),
      line.lowBridge('red-cut-bridge', 5000, 'Red Cut footbridge'),
      line.lowBridge('lone-pine-bridge', ['lone-pine', 1650], 'Lone Pine footbridge'),
      line.lowBridge('mesa-bridge', 11000, 'Mesa wagon bridge'),
    ],
    fords: [line.ford('cedar-wash-ford', 'Cedar Wash ford', [7660, 7740]), line.ford('mesa-creek-ford', 'Mesa Creek ford', [10300, 10400])],
    trestles: [line.trestle('devils-trestle', 'the Devil’s Trestle', [9850, 10100], 13.4)],
    curves: [line.curve('devils-elbow', [9000, 9400], 13.4), line.curve('lone-pine-bend', ['lone-pine', 1750, 2050], 13)],
    grades: [line.grade([9400, 9600], -0.006), line.grade([9600, 9800], -0.006), line.grade(['lone-pine', 0, 1600], 0.006)],
    signals: [
      line.signal('buzzard-signal', 3200, buzzard, 'Buzzard Rock junction signal'),
      line.signal('red-cut-signal', 5500),
      line.signal('lone-pine-signal', ['lone-pine', 2100]),
      line.signal('cedar-wash-starter', 7600, undefined, 'Cedar Wash starter'),
      line.signal('elbow-signal', 8800),
      line.signal('trestle-signal', 10700),
      line.signal('mesa-home', 11900, undefined, 'Mesa home signal'),
    ],
    obstacles: [
      line.obstacle('red-cut-slide', 'rocks', 4700, ['A']),
      line.obstacle('lone-pine-slide', 'rocks', ['lone-pine', 1300], ['B']),
      line.obstacle('longhorns', 'cattle', 2100),
      line.obstacle('cedar-herd', 'cattle', 6850),
      line.obstacle('mesa-strays', 'cattle', 11700),
    ],
    // A pair waits at Buzzard tank; riders come for the cab whichever way we go past Buzzard Rock
    // (Red Cut or the loop); then the chase into Cedar Wash and the ambush past Cedar Tunnel. The
    // Devil's Elbow and the trestle are left to the crew, and the last band rides in after.
    waves: [
      line.wave('pale-rock-riders', 1300, 3, 'rear', 'safe', 1),
      line.wave('buzzard-ambush', 2500, 2, 'ahead', 'hunt', 1),
      line.wave('red-cut-riders', 4300, 3, 'rear', 'cab', 2),
      line.wave('lone-pine-riders', ['lone-pine', 900], 3, 'rear', 'cab', 2),
      line.wave('cedar-riders', 6600, 3, 'rear', 'hunt', 2),
      line.wave('elbow-ambush', 8000, 3, 'ahead', 'safe', 2),
      line.wave('mesa-riders', 10800, 4, 'rear', 'mixed', 2),
    ],
    telegrams: [
      line.telegram('slide', { clock: clock(12, 30, 5) }, 'ROCKSLIDE PAST BUZZARD ROCK. NOT KNOWN IF RED CUT OR LONE PINE LOOP. READ THE JUNCTION SIGNAL.'),
      line.telegram('trestle', 8000, 'DEVIL’S TRESTLE AFIRE. CROSS FAST OR NOT AT ALL.'),
    ],
    contract: { cargo: 'silver', title: 'Silver bullion for the Mesa assay office', pay: 260, destination: 'mesa', deadline: clock(12, 46), latePenaltyPerMin: 20, critical: true },
    origin: 'pale-rock',
    initialWater: 100,
    variants: ['A', 'B'],
    requiredCars: ['express'],
    par: 780,
    plan: {
      // A: the slide is in Red Cut; go round by the Lone Pine loop.
      A: { cruise: 20, switches: [{ junction: buzzard, state: 'reverse' }], stops, holds: [], whistles, minSpeeds },
      // B: the slide is on the loop; stay on the main line through Red Cut.
      B: { cruise: 20, switches: [], stops, holds: [], whistles, minSpeeds },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 4. Single Track: passing loops, the timetable chart, an opposing freight to meet at Dry Wash
// siding, block signals guarding the single line, passengers for a side job, and cattle loose along
// the line. Dry Wash's platform is on the siding, so the station stop and the meet overlap. About 13
// minutes.
// ---------------------------------------------------------------------------------------------

function singleTrack(): RunDef {
  const line = new Line({
    length: 10800,
    speed: 25,
    ends: ['To Pale Rock', 'To Tanner’s Pass'],
    terrain: [
      [0, 'town'],
      [900, 'desert'],
      [2900, 'river'],
      [3300, 'town'],
      [4300, 'mesa'],
      [5700, 'town'],
      [6600, 'hills'],
      [8500, 'canyon'],
      [9100, 'river'],
      [9600, 'town'],
    ],
    loops: [
      { id: 'yucca', name: 'Yucca siding', from: 2300, to: 2700, side: 1 },
      { id: 'dry-wash', name: 'Dry Wash siding', from: 6000, to: 6450, side: 1 },
    ],
  });
  // No. 7 comes west down the single line; we must be in Dry Wash siding when it passes. By the
  // estimate we stand at the Dry Wash platform from 3:07:08, No. 7 reaches the siding at 3:08:06 and
  // clears it at 3:08:48, and we pull out at 3:09:20. Run straight on and we meet it head-on.
  const no7: AiTrainDef = {
    id: 'no7',
    name: 'No. 7 Freight',
    kind: 'freight',
    cars: 11,
    length: 140,
    route: line.route('east'),
    depart: clock(15, 2, 55),
    speed: 14,
    stops: [],
    charted: true,
  };
  const dryWash = line.junction('dry-wash', 'w');
  // One blast for each herd, 170 m short of it (spec §8): out of Mesa, past Dry Wash once No. 7 has
  // gone by, and on the Sidewinder curve.
  const whistles = [line.at(830), line.at(6580), line.at(8730)];
  return makeRun(line, {
    id: 'single-track',
    index: 3,
    act: 2,
    name: 'Single Track',
    flavor: 'One track, two directions, and No. 7 Freight coming the other way. The Silver Flats bank wants its cash before closing, and the dispatcher’s timetable is all that keeps you off No. 7’s cowcatcher.',
    briefing: {
      rider: [
        'When we pull into a siding, look back from the rear and tell the Engineer when the last car is clear of the main line.',
        'A bandit in the cab holds the Engineer at gunpoint and the levers go dead. Clear the cab fast.',
        'Block signals guard the single line: red means a train in the block ahead. Call every one as it goes by.',
      ],
      engineer: [
        'The timetable chart draws No. 7 Freight as a line. Where it crosses yours you must be in a siding: meet him at Dry Wash.',
        'Dry Wash’s platform is on the siding. Set the switch before you reach it, stop at the platform, then pull up clear and wait for No. 7 to pass.',
        'With a passenger car, carry four passengers from Red Butte to Dry Wash (+$80): stop at both.',
      ],
    },
    startClock: clock(15, 0),
    night: false,
    stations: [
      line.station('mesa', 'Mesa', 500, { platform: 120 }),
      line.station('red-butte', 'Red Butte', 3800, { platform: 100, checkpoint: true, water: true }),
      line.station('dry-wash', 'Dry Wash', ['dry-wash', 280], { platform: 100, checkpoint: true, water: true }),
      line.station('silver-flats', 'Silver Flats', 10100, { platform: 120 }),
    ],
    // Crouch, up, the stop, crouch, down; Dry Wash; down, crouch, down, up.
    tunnels: [
      line.tunnel('butte-tunnel', 'Butte Tunnel', [5150, 5400]),
      line.tunnel('dry-wash-tunnel', 'Dry Wash Tunnel', [7000, 7250]),
      line.tunnel('sidewinder-tunnel', 'Sidewinder Tunnel', [8250, 8450]),
    ],
    lowBridges: [
      line.lowBridge('mesa-road-bridge', 1300, 'Mesa road bridge'),
      line.lowBridge('butte-bridge', 4700, 'Red Butte stock bridge'),
      line.lowBridge('hat-rock-bridge', 7650, 'Hat Rock footbridge'),
    ],
    fords: [line.ford('yucca-creek-ford', 'Yucca Creek ford', [3000, 3100]), line.ford('silver-creek-ford', 'Silver Creek ford', [9200, 9300])],
    curves: [line.curve('sidewinder-curve', [8700, 9100], 13)],
    grades: [line.grade([4300, 5000], 0.007), line.grade([6600, 7000], -0.005)],
    signals: [
      line.signal('mesa-starter', 700, undefined, 'Mesa starter'),
      line.signal('yucca-signal', 1900, line.junction('yucca', 'w'), 'Yucca junction signal'),
      line.signal('yucca-main-exit', 2675),
      line.signal('yucca-siding-exit', ['yucca', 375]),
      line.signal('red-butte-starter', 3950, undefined, 'Red Butte starter'),
      line.signal('dry-wash-signal', 5680, dryWash, 'Dry Wash junction signal'),
      line.signal('dry-wash-main-exit', 6425),
      line.signal('dry-wash-siding-exit', ['dry-wash', 425]),
      line.signal('sidewinder-signal', 8000),
      line.signal('silver-flats-home', 9700, undefined, 'Silver Flats home signal'),
    ],
    obstacles: [line.obstacle('mesa-herd', 'cattle', 1000), line.obstacle('hat-rock-herd', 'cattle', 6750), line.obstacle('sidewinder-herd', 'cattle', 8900)],
    // Riders out of Mesa and into Red Butte, and an ambush after it; none on the way into the meet,
    // where a gun in the cab could leave us on the main; then two bands once No. 7 has gone by.
    waves: [
      line.wave('mesa-riders', 1500, 3, 'rear', 'safe', 2),
      line.wave('butte-riders', 3350, 3, 'rear', 'hunt', 2),
      line.wave('butte-ambush', 4400, 3, 'ahead', 'cab', 2),
      line.wave('hat-rock-riders', 6900, 3, 'rear', 'safe', 2),
      line.wave('canyon-riders', 8100, 4, 'rear', 'mixed', 2),
    ],
    aiTrains: [no7],
    telegrams: [
      line.telegram(
        'meet',
        { clock: clock(15, 0, 5) },
        `DISPATCHER TO MESA: NO. 7 FREIGHT WESTBOUND ON TIME, DUE DRY WASH ${clockText(line.reachesSection(no7, 'dry-wash'))}. MEET HIM THERE.`,
      ),
    ],
    sideJobs: [{ id: 'red-butte-passengers', title: '4 passengers, Red Butte to Dry Wash', pay: 80, from: 'red-butte', to: 'dry-wash', needs: 'passenger' }],
    contract: { cargo: 'cash', title: 'Bank cash for Silver Flats', pay: 240, destination: 'silver-flats', deadline: clock(15, 17), latePenaltyPerMin: 20, critical: true },
    origin: 'mesa',
    initialWater: 100,
    variants: ['main'],
    requiredCars: ['express'],
    par: 820,
    plan: {
      main: {
        cruise: 20,
        switches: [{ junction: dryWash, state: 'reverse' }],
        stops: ['red-butte', 'dry-wash', 'silver-flats'],
        holds: [{ at: line.at(['dry-wash', 400]), until: after(line.clearsSection(no7, 'dry-wash'), 30) }],
        whistles,
        minSpeeds: [],
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 5. Night Freight: by lamplight, with a short spyglass. No. 4 Express overtakes us (we let it by at
// Coyote Wells siding before it turns off for Red Rock), then we meet No. 7 Freight at Dry Creek
// siding, taking water at each while we wait. Dynamite in the powder car, horsemen shooting at it,
// and cattle on the line in the dark. About 14 minutes.
// ---------------------------------------------------------------------------------------------

function nightFreight(): RunDef {
  const line = new Line({
    length: 9800,
    speed: 25,
    ends: ['To Mesa', 'To Summit'],
    terrain: [
      [0, 'town'],
      [1000, 'desert'],
      [1800, 'mesa'],
      [3100, 'river'],
      [3300, 'mesa'],
      [3800, 'town'],
      [4400, 'hills'],
      [6200, 'canyon'],
      [7200, 'river'],
      [7600, 'hills'],
      [8500, 'town'],
    ],
    loops: [
      { id: 'coyote-wells', name: 'Coyote Wells siding', from: 2600, to: 3000, side: 1 },
      { id: 'dry-creek', name: 'Dry Creek siding', from: 6400, to: 6800, side: 1 },
    ],
    spurs: [{ id: 'red-rock', name: 'Red Rock branch', at: 3500, length: 800, toward: 1, side: -1, kind: 'branch', speed: 20, terrain: 'mesa', switchName: 'Red Rock Jct.', label: 'To Red Rock' }],
  });
  // No. 4 comes up behind us at 56 mph and turns off for Red Rock just past Coyote Wells. We're at
  // the Coyote Wells tank by 10:02:55, it goes by 10:03:54–10:04:15, and we follow it out at 10:04:55.
  const no4: AiTrainDef = {
    id: 'no4',
    name: 'No. 4 Express',
    kind: 'express',
    cars: 6,
    length: 120,
    route: line.route('west', { leave: 'red-rock' }),
    depart: clock(22, 2, 10),
    speed: 25,
    stops: [],
    charted: true,
  };
  // No. 7 comes west down the whole line. We're at the Dry Creek tank by 10:09:02, it goes by
  // 10:09:59–10:10:38, and we pull out at 10:11:10.
  const no7: AiTrainDef = {
    id: 'no7',
    name: 'No. 7 Freight',
    kind: 'freight',
    cars: 10,
    length: 140,
    route: line.route('east'),
    depart: clock(22, 6, 25),
    speed: 14,
    stops: [],
    charted: true,
  };
  const coyoteWells = line.junction('coyote-wells', 'w');
  const dryCreek = line.junction('dry-creek', 'w');
  // One blast for each herd, 170 m short of it (spec §8): the short spyglass still finds them first.
  const whistles = [line.at(930), line.at(7630)];
  return makeRun(line, {
    id: 'night-freight',
    index: 4,
    act: 2,
    name: 'Night Freight',
    flavor: 'Dynamite for the crews blasting Tanner’s Pass, hauled by night when the line is quiet. It isn’t quiet: No. 4 Express is on your tail, No. 7 is coming the other way, and the Blackwater Gang wants that powder.',
    briefing: {
      rider: [
        'At night you see only the signal lamps: call each one as it goes by. The spyglass reaches only about 330 yards.',
        'Horsemen will pace the powder car and shoot at it. Twelve hits and it blows: keep them off it before anything else.',
        'In the sidings, watch the main line and tell the Engineer when No. 4 and No. 7 have gone by.',
      ],
      engineer: [
        'No. 4 Express overtakes you tonight. Be inside Coyote Wells siding before it catches you, and let it by.',
        'Then meet No. 7 Freight at Dry Creek siding: both trains cross your line on the timetable.',
        'Both sidings have a water tank: fill up while you wait.',
      ],
    },
    startClock: clock(22, 0),
    night: true,
    stations: [
      line.station('silver-flats', 'Silver Flats', 600, { platform: 120 }),
      line.station('red-rock-jct', 'Red Rock Jct.', 4100, { platform: 80, checkpoint: true, water: true }),
      line.station('tanners-pass', 'Tanner’s Pass', 9000, { platform: 100 }),
    ],
    waterTowers: [line.tower('coyote-wells-tank', ['coyote-wells', 140], 'Coyote Wells tank'), line.tower('dry-creek-tank', ['dry-creek', 140], 'Dry Creek tank')],
    // Crouch, down; Coyote Wells; up, crouch, down, crouch; Dry Creek; down, the trestle, crouch.
    tunnels: [
      line.tunnel('flat-top-tunnel', 'Flat Top Tunnel', [1850, 2100]),
      line.tunnel('red-rock-tunnel', 'Red Rock Tunnel', [4700, 4950]),
      line.tunnel('dry-creek-tunnel', 'Dry Creek Tunnel', [6900, 7080]),
    ],
    lowBridges: [
      line.lowBridge('flats-bridge', 1400, 'Silver Flats road bridge'),
      line.lowBridge('red-rock-bridge', 3700, 'Red Rock wagon bridge'),
      line.lowBridge('canyon-flume', 5800, 'Canyon flume'),
      line.lowBridge('pass-bridge', 8100, 'Tanner’s Pass footbridge'),
    ],
    fords: [line.ford('coyote-creek-ford', 'Coyote Creek ford', [3150, 3250])],
    trestles: [line.trestle('dry-creek-trestle', 'Dry Creek Trestle', [7300, 7480])],
    curves: [line.curve('flats-curve', [2400, 2560], 14), line.curve('canyon-curve', [7700, 8000], 12)],
    grades: [line.grade([4400, 5500], 0.008), line.grade([7600, 8500], 0.006)],
    signals: [
      line.signal('silver-flats-starter', 800, undefined, 'Silver Flats starter'),
      line.signal('coyote-wells-signal', 2280, coyoteWells, 'Coyote Wells junction signal'),
      line.signal('coyote-wells-main-exit', 2975),
      line.signal('coyote-wells-siding-exit', ['coyote-wells', 375]),
      line.signal('red-rock-signal', 4400),
      line.signal('dry-creek-signal', 6080, dryCreek, 'Dry Creek junction signal'),
      line.signal('dry-creek-main-exit', 6775),
      line.signal('dry-creek-siding-exit', ['dry-creek', 375]),
      line.signal('tanners-home', 8600, undefined, 'Tanner’s Pass home signal'),
    ],
    obstacles: [line.obstacle('flats-herd', 'cattle', 1100), line.obstacle('canyon-herd', 'cattle', 7800)],
    // Nobody rides in on the way into either siding, where a gun in the cab could leave us on the
    // main: the powder riders come early, the rest between the meets and after them.
    waves: [
      line.wave('flats-riders', 1600, 3, 'rear', 'powder', 2),
      line.wave('wells-riders', 3520, 3, 'rear', 'hunt', 2),
      line.wave('red-rock-ambush', 4200, 3, 'ahead', 'cab', 2),
      line.wave('canyon-riders', 5300, 3, 'rear', 'hunt', 2),
      line.wave('pass-riders', 7000, 4, 'rear', 'powder', 3),
      line.wave('pass-ambush', 8000, 3, 'ahead', 'cab', 3),
    ],
    aiTrains: [no4, no7],
    telegrams: [
      line.telegram('express', { clock: clock(22, 0, 5) }, `NO. 4 EXPRESS DUE THROUGH SILVER FLATS ${clockText(line.arrives(no4, 600))} RUNNING FAST. CLEAR THE MAIN FOR HIM AT COYOTE WELLS.`),
      line.telegram('freight', 3600, `NO. 7 FREIGHT WESTBOUND, DUE DRY CREEK ${clockText(line.reachesSection(no7, 'dry-creek'))}. MEET HIM THERE.`),
    ],
    contract: { cargo: 'dynamite', title: 'Blasting powder for the Tanner’s Pass crews', pay: 300, destination: 'tanners-pass', deadline: clock(22, 17), latePenaltyPerMin: 25, critical: true },
    origin: 'silver-flats',
    initialWater: 100,
    variants: ['main'],
    requiredCars: ['powder'],
    par: 850,
    plan: {
      main: {
        cruise: 20,
        switches: [
          { junction: coyoteWells, state: 'reverse' },
          { junction: dryCreek, state: 'reverse' },
        ],
        stops: ['coyote-wells-tank', 'dry-creek-tank', 'tanners-pass'],
        holds: [
          // No. 4 must be past the siding and off onto the Red Rock branch before we follow it out.
          { at: line.at(['coyote-wells', 355]), until: after(Math.max(line.clearsSection(no4, 'coyote-wells'), line.clears(no4, ['red-rock', 0])), 20) },
          { at: line.at(['dry-creek', 355]), until: after(line.clearsSection(no7, 'dry-creek'), 30) },
        ],
        whistles,
        minSpeeds: [],
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 6. The Blackwater Line: everything at once. A rockslide one way through Blackwater Canyon
// (variant A: the canyon main line, B: Hangman's cutoff), cattle, a meet with No. 7 at Blackwater
// siding, Black Jack Harlan's gang, a barricade ambush just past Quarry, and the runaway: ore cars
// loose from Summit, to be turned into the quarry spur. About 14 minutes.
// ---------------------------------------------------------------------------------------------

function blackwater(): RunDef {
  const line = new Line({
    length: 10600,
    speed: 25,
    ends: ['To Dry Creek', 'To the Summit mine'],
    terrain: [
      [0, 'town'],
      [1000, 'hills'],
      [2500, 'desert'],
      [2800, 'canyon'],
      [5100, 'town'],
      [5900, 'river'],
      [6100, 'town'],
      [6300, 'hills'],
      [7000, 'river'],
      [7400, 'canyon'],
      [8100, 'town'],
      [9000, 'mesa'],
      [9400, 'town'],
    ],
    cutoffs: [
      {
        id: 'hangman',
        name: 'Hangman’s cutoff',
        from: 2900,
        to: 4800,
        speed: 16,
        parts: [
          [800, 'hills'],
          [800, 'mesa'],
        ],
        junctions: ['Blackwater Jct.', 'Hangman’s Jct.'],
        side: 1,
      },
    ],
    loops: [{ id: 'blackwater', name: 'Blackwater siding', from: 5400, to: 5850, side: -1 }],
    spurs: [{ id: 'quarry', name: 'Quarry spur', at: 8850, length: 300, toward: -1, side: -1, terrain: 'mesa', switchName: 'Quarry switch' }],
  });
  // No. 7 comes down from Summit. We stand at the Blackwater platform, on the siding, from about
  // 4:36:40; it goes by 4:37:39–4:38:21 and we pull out at 4:38:55.
  const no7: AiTrainDef = {
    id: 'no7',
    name: 'No. 7 Freight',
    kind: 'freight',
    cars: 11,
    length: 140,
    route: line.route('east'),
    depart: clock(16, 32, 0),
    speed: 14,
    stops: [],
    charted: true,
  };
  // Loose ore cars from the Summit tipple, rolling west down the grade. They follow the switches:
  // with the Quarry switch reversed they pile into the quarry spur's buffers. They break loose as we
  // come into Quarry (600 m short of the platform) and reach the switch about 96 s later; the Quarry
  // starter's block reaches past Summit, so it holds us until they're in the spur.
  const runaway: AiTrainDef = {
    id: 'runaway',
    name: 'Runaway ore cars',
    kind: 'runaway',
    cars: 3,
    length: 30,
    route: [],
    depart: clock(16, 30),
    speed: 14,
    stops: [],
    charted: false,
    runaway: {
      start: line.at(9950),
      dir: -1,
      trigger: line.at(7850),
      telegram: 'RUNAWAY. ORE CARS LOOSE FROM THE SUMMIT TIPPLE, ROLLING WEST ON THE MAIN. THROW THE QUARRY SWITCH AND TURN THEM INTO THE SPUR.',
    },
  };
  const blackwaterJct = line.junction('hangman', 'w');
  const siding = line.junction('blackwater', 'w');
  const quarry = line.junction('quarry', 'j');
  const stops = ['tanners-tank', 'blackwater', 'quarry', 'summit'];
  const holds = [{ at: line.at(['blackwater', 400]), until: after(line.clearsSection(no7, 'blackwater'), 30) }];
  // One blast for each herd as the loco passes 170 m short of it (spec §8). The strays stand 350 m
  // past Tanner's Tunnel, in reach of the spyglass before it: spot them, get down, come up and call
  // it. A second herd grazes whichever way through the canyon the rockslide leaves open, on a curve.
  const strays = line.at(1730);
  return makeRun(line, {
    id: 'blackwater',
    index: 5,
    act: 2,
    name: 'The Blackwater Line',
    flavor: 'The last gold out of Tanner’s Pass, up the Blackwater Line to Summit. Black Jack Harlan’s gang has sworn it never gets there.',
    briefing: {
      rider: [
        'Black Jack Harlan rides for the safe himself: eight bullets’ worth of outlaw. Keep him out of the express car.',
        'The gang has barricaded the line somewhere past Blackwater. Spot it with the spyglass and tell the Engineer to take it at a crawl.',
        'Past Quarry, watch the line ahead: if anything comes rolling down from Summit, you’ll see it before the Engineer can.',
      ],
      engineer: [
        'A rockslide blocks one way through Blackwater Canyon: have the Rider read the junction signal before you commit.',
        'Meet No. 7 Freight at Blackwater: the platform is on the siding, so take water there while he goes by.',
        'If cars break loose above Quarry, throw the Quarry switch: a runaway follows the switches and will pile into the spur’s buffers.',
      ],
    },
    startClock: clock(16, 30),
    night: false,
    stations: [
      line.station('tanners-pass', 'Tanner’s Pass', 500, { platform: 100 }),
      line.station('blackwater', 'Blackwater', ['blackwater', 280], { platform: 100, checkpoint: true, water: true }),
      line.station('quarry', 'Quarry', 8450, { platform: 80, checkpoint: true, water: true }),
      line.station('summit', 'Summit', 9600, { platform: 110 }),
    ],
    waterTowers: [line.tower('tanners-tank', 2250, 'Tanner’s tank')],
    // Down, crouch; either way through the canyon, down and crouch; Blackwater; up, crouch, down;
    // Quarry; down.
    tunnels: [
      line.tunnel('tanners-tunnel', 'Tanner’s Tunnel', [1300, 1550]),
      line.tunnel('narrows-tunnel', 'Narrows Tunnel', [3050, 3300]),
      line.tunnel('hangman-tunnel', 'Hangman’s Tunnel', ['hangman', 150, 350]),
      line.tunnel('quarry-tunnel', 'Quarry Tunnel', [7500, 7720]),
      line.tunnel('summit-tunnel', 'Summit Tunnel', [9050, 9250]),
    ],
    lowBridges: [
      line.lowBridge('alkali-bridge', 2650, 'Alkali stock bridge'),
      line.lowBridge('gallows-bridge', ['hangman', 1300], 'Gallows footbridge'),
      line.lowBridge('canyon-bridge', 4550, 'Blackwater road bridge'),
      line.lowBridge('deadmans-flume', 6500, 'Deadman’s flume'),
    ],
    fords: [line.ford('blackwater-ford', 'Blackwater ford', [5960, 6060])],
    trestles: [line.trestle('blackwater-trestle', 'Blackwater Trestle', [7100, 7300])],
    curves: [line.curve('blackwater-bend', [3800, 4050], 12), line.curve('hangman-curve', ['hangman', 900, 1150], 12)],
    grades: [line.grade(['hangman', 0, 800], 0.015), line.grade(['hangman', 800, 1600], -0.015), line.grade([7400, 8100], 0.008), line.grade([9400, 10600], 0.01)],
    signals: [
      line.signal('blackwater-junction-signal', 2500, blackwaterJct, 'Blackwater junction signal'),
      line.signal('canyon-signal', 4300),
      line.signal('hangman-signal', ['hangman', 1100]),
      line.signal('siding-signal', 5080, siding, 'Blackwater siding signal'),
      line.signal('blackwater-main-exit', 5825),
      line.signal('blackwater-siding-exit', ['blackwater', 425]),
      // Its block reaches past Summit, so it holds us while anything is loose on the hill.
      line.signal('quarry-starter', 8530, undefined, 'Quarry starter'),
    ],
    obstacles: [
      line.obstacle('canyon-slide', 'rocks', 3600, ['A']),
      line.obstacle('hangman-slide', 'rocks', ['hangman', 600], ['B']),
      line.obstacle('strays', 'cattle', 1900),
      line.obstacle('gallows-herd', 'cattle', ['hangman', 960], ['A']),
      line.obstacle('bend-herd', 'cattle', 4000, ['B']),
      line.obstacle('barricade', 'barricade', 8480),
    ],
    // Riders out of the tunnels whichever way we go through the canyon, the chase to Blackwater,
    // Harlan and his gang, and the barricade. Nobody else rides in while the runaway is loose: it
    // wants the crew's eyes. The last of the gang chase us up to Summit once it's in the spur.
    waves: [
      line.wave('tanner-riders', 1700, 3, 'rear', 'safe', 2),
      line.wave('narrows-riders', 3450, 3, 'rear', 'hunt', 2),
      line.wave('hangman-riders', ['hangman', 450], 3, 'rear', 'hunt', 2),
      line.wave('canyon-riders', 5000, 4, 'rear', 'mixed', 2),
      line.wave('harlan-gang', 6700, 3, 'rear', 'hunt', 2),
      line.wave('harlan', 6750, 3, 'rear', 'safe', 3, { boss: true }),
      line.wave('barricade-ambush', 8030, 4, 'ahead', 'cab', 3),
      line.wave('summit-riders', 8950, 3, 'rear', 'hunt', 3),
    ],
    aiTrains: [no7, runaway],
    telegrams: [
      line.telegram('slide', { clock: clock(16, 30, 5) }, 'ROCKSLIDE IN BLACKWATER CANYON. NOT KNOWN IF CANYON LINE OR HANGMAN’S CUTOFF. READ THE JUNCTION SIGNAL.'),
      line.telegram('meet', 4900, `NO. 7 FREIGHT DUE BLACKWATER ${clockText(line.reachesSection(no7, 'blackwater'))}. TAKE THE SIDING.`),
      line.telegram('harlan', 6200, 'HARLAN AND HIS GANG SEEN RIDING FOR THE LINE EAST OF BLACKWATER. GOOD LUCK.'),
    ],
    contract: { cargo: 'gold', title: 'Gold for the Summit bank', pay: 400, destination: 'summit', deadline: clock(16, 47), latePenaltyPerMin: 30, critical: true },
    origin: 'tanners-pass',
    initialWater: 100,
    variants: ['A', 'B'],
    requiredCars: ['express'],
    par: 860,
    plan: {
      // A: the slide is in the canyon; take Hangman's cutoff.
      A: {
        cruise: 20,
        switches: [
          { junction: blackwaterJct, state: 'reverse' },
          { junction: siding, state: 'reverse' },
          { junction: quarry, state: 'reverse' },
        ],
        stops,
        holds,
        whistles: [strays, line.at(['hangman', 790])],
        minSpeeds: [],
      },
      // B: the slide is on the cutoff; stay on the canyon main line.
      B: {
        cruise: 20,
        switches: [
          { junction: siding, state: 'reverse' },
          { junction: quarry, state: 'reverse' },
        ],
        stops,
        holds,
        whistles: [strays, line.at(3830)],
        minSpeeds: [],
      },
    },
  });
}

export const RUNS: readonly RunDef[] = [firstLight(), payroll(), signalCountry(), singleTrack(), nightFreight(), blackwater()];

export function runById(id: string): RunDef | undefined {
  return RUNS.find((r) => r.id === id);
}
