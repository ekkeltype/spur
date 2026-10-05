// The hold-up, as the Engineer sees it (spec §5.2, §11): an outlaw rises into the desk with a
// revolver levelled at you while a bandit holds the cab, jabs it when you reach for a lever, and
// drops away when the Rider clears the cab. Flavour only: the banner over the cab says what it means.

const NS = 'http://www.w3.org/2000/svg';

/** What he says while he holds you: a line as he comes in, then another every so often. */
const LINES = [
  'Easy, hogger. Hands where I can see ’em.',
  'Not one twitch on that throttle, friend.',
  'Keep ’em high, driver. This train’s mine now.',
  'Reach for the sky, and leave the brake be.',
  'Nice and slow now. Nobody needs to get hurt.',
  'Stand clear of them levers, old-timer.',
  'That’s a fine engine. Shame if she stopped for good.',
  'Your pardner up top ain’t coming. Sit tight.',
  'Whistle all you like. Nobody’s listening.',
  'Harlan sends his regards.',
  'Ever been robbed before? It’s easy. You do nothing.',
  'This here’s a hold-up, in case you wondered.',
];

/** What he says when you reach for a lever anyway. */
const WARNINGS = ['Uh-uh.', 'I said hands up!', 'Try that again, hogger.', 'Don’t make me.', 'Easy!', 'Keep reaching and you’ll lose the hand.'];

/** A new line every this many ms while he holds you. */
const LINE_MS = 6000;

/** The outlaw, bottom-anchored in a 360×320 box: coat, head and hat, and the gun arm reaching at you. */
const ART = `
<path d="M40 320 C52 262 92 228 150 214 L250 214 C300 226 336 262 350 320 Z" fill="#231b14"/>
<path d="M170 214 L200 266 L230 214 Z" fill="#33271d"/>
<path d="M188 214 L200 236 L212 214 Z" fill="#6b4524"/>
<rect x="178" y="176" width="44" height="44" rx="10" fill="#7d5236"/>
<ellipse cx="160" cy="150" rx="7" ry="11" fill="#95633f"/>
<ellipse cx="240" cy="150" rx="7" ry="11" fill="#95633f"/>
<ellipse cx="200" cy="148" rx="40" ry="46" fill="#ad7751"/>
<path d="M160 110 Q200 124 240 110 L240 121 Q200 135 160 121 Z" fill="#000" opacity="0.3"/>
<path d="M168 117 L193 125" stroke="#2a1d14" stroke-width="4.5" stroke-linecap="round"/>
<path d="M232 117 L207 125" stroke="#2a1d14" stroke-width="4.5" stroke-linecap="round"/>
<path d="M171 130 Q182 122 193 130 Q182 134 171 130 Z" fill="#150e09"/>
<path d="M207 130 Q218 122 229 130 Q218 134 207 130 Z" fill="#150e09"/>
<circle cx="184" cy="129" r="1.6" fill="#f2d493"/>
<circle cx="220" cy="129" r="1.6" fill="#f2d493"/>
<path d="M157 146 Q200 137 243 146 L247 176 Q229 207 200 238 Q171 207 153 176 Z" fill="#a8321f"/>
<path d="M157 146 Q200 137 243 146 L244 152 Q200 144 156 152 Z" fill="#c24a33"/>
<path d="M168 170 Q200 185 232 170" stroke="#772014" stroke-width="3" fill="none"/>
<path d="M177 193 Q200 206 223 193" stroke="#772014" stroke-width="3" fill="none"/>
<path d="M188 216 Q200 224 212 216" stroke="#772014" stroke-width="2.5" fill="none"/>
<g fill="#e9b59c">
  <circle cx="178" cy="160" r="2.2"/><circle cx="200" cy="158" r="2.2"/><circle cx="222" cy="160" r="2.2"/>
  <circle cx="189" cy="178" r="2"/><circle cx="211" cy="178" r="2"/><circle cx="200" cy="198" r="2"/>
</g>
<ellipse cx="200" cy="107" rx="94" ry="17" fill="#18120d"/>
<ellipse cx="200" cy="103" rx="94" ry="14" fill="#2a2018"/>
<path d="M150 105 C150 70 162 48 180 46 Q200 57 220 46 C238 48 250 70 250 105 Z" fill="#2e231a"/>
<path d="M151 93 Q200 101 249 93 L250 105 Q200 113 150 105 Z" fill="#6b4524"/>
<path d="M200 55 L200 90" stroke="#3d2f22" stroke-width="3"/>
<path d="M60 320 C70 270 88 238 110 224 L152 234 C142 264 130 296 122 320 Z" fill="#2b2119"/>
<g class="dk-outlaw-gun">
  <ellipse cx="124" cy="224" rx="31" ry="22" fill="#3a2c20"/>
  <path d="M95 214 Q91 188 108 182 L142 182 Q157 188 153 214 Q151 234 124 238 Q99 234 95 214 Z" fill="#5e3f26"/>
  <path d="M101 199 Q124 206 147 199" stroke="#3f2917" stroke-width="3" fill="none"/>
  <path d="M103 212 Q124 219 145 212" stroke="#3f2917" stroke-width="3" fill="none"/>
  <path d="M109 184 Q124 176 139 184 L136 190 Q124 184 112 190 Z" fill="#26282c"/>
  <circle cx="124" cy="160" r="31" fill="#2f3237"/>
  <circle cx="124" cy="160" r="27" fill="#3b3f45"/>
  <g fill="#0f1012">
    <circle cx="140.5" cy="169.5" r="6"/><circle cx="124" cy="179" r="6"/><circle cx="107.5" cy="169.5" r="6"/>
    <circle cx="107.5" cy="150.5" r="6"/><circle cx="140.5" cy="150.5" r="6"/>
  </g>
  <path d="M100 152 A26 26 0 0 1 116 135" stroke="#a7adb5" stroke-width="2.5" fill="none" opacity="0.7"/>
  <circle cx="124" cy="141" r="15" fill="#4a4e55"/>
  <circle cx="124" cy="141" r="12" fill="#3a3d43"/>
  <circle cx="124" cy="141" r="7" fill="#040405"/>
  <path d="M113 136 A12 12 0 0 1 121 130" stroke="#c9ced5" stroke-width="2" fill="none" opacity="0.8"/>
  <rect x="121" y="121" width="6" height="9" rx="1.5" fill="#4a4e55"/>
  <circle class="dk-outlaw-glint" cx="116" cy="133" r="2.6" fill="#fff6dc"/>
</g>`;

export class OutlawView {
  readonly el: HTMLElement;
  private readonly say: HTMLElement;
  private readonly vignette: HTMLElement;
  private shown = false;
  private hideTimer: number | undefined;
  private lineTimer: number | undefined;
  private lastLine = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'dk-outlaw';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 360 320');
    svg.setAttribute('class', 'dk-outlaw-art');
    svg.innerHTML = ART;
    this.say = document.createElement('div');
    this.say.className = 'dk-outlaw-say';
    this.el.append(svg, this.say);
    this.vignette = document.createElement('div');
    this.vignette.className = 'dk-outlaw-vignette';
    this.vignette.hidden = true;
  }

  /** Both parts go into the desk: the vignette over everything, the outlaw over the timetable. */
  mount(desk: HTMLElement): void {
    desk.append(this.vignette, this.el);
  }

  /** Follows the view: in when a bandit holds the cab, out when the cab is clear. */
  set(held: boolean): void {
    if (held === this.shown) return;
    this.shown = held;
    window.clearTimeout(this.hideTimer);
    if (held) {
      this.speak(LINES);
      this.lineTimer = window.setInterval(() => this.speak(LINES), LINE_MS);
      this.el.hidden = false;
      this.vignette.hidden = false;
      replay(this.el, 'dk-outlaw-in');
      this.el.classList.remove('dk-outlaw-out');
    } else {
      window.clearInterval(this.lineTimer);
      this.el.classList.remove('dk-outlaw-in');
      replay(this.el, 'dk-outlaw-out');
      this.vignette.hidden = true;
      this.hideTimer = window.setTimeout(() => {
        if (!this.shown) this.el.hidden = true;
      }, 450);
    }
  }

  /** The Engineer reached for a lever: the gun comes closer, with a word. */
  jab(): void {
    if (!this.shown) return;
    this.speak(WARNINGS);
    this.el.classList.remove('dk-outlaw-in');
    replay(this.el, 'dk-outlaw-jab');
  }

  /** Says a line from `lines`, never the one he just said. */
  private speak(lines: readonly string[]): void {
    const fresh = lines.filter((l) => l !== this.lastLine);
    this.lastLine = fresh[Math.floor(Math.random() * fresh.length)] ?? lines[0];
    this.say.textContent = this.lastLine;
  }

  destroy(): void {
    window.clearTimeout(this.hideTimer);
    window.clearInterval(this.lineTimer);
    this.el.remove();
    this.vignette.remove();
  }
}

/** Restarts a CSS animation class. */
function replay(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}
