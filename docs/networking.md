## Online play

Spur is a static website with no game server. The two players' browsers talk to each other
directly over WebRTC. A small public matchmaking server only introduces them.

### How it works

1. **the Rider hosts.** His browser runs the game and registers a room with the matchmaking
   (signalling) server under the id `spur-<CODE>`, then shows the code: five characters from
   `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. `I`, `O`, `0` and `1` are left out so the code can't be
   misread.
2. **the Engineer joins** by typing the code. Case, spaces and dashes don't matter. There is no
   guessing at look-alikes: `I`, `O`, `0` and `1` never appear in a code, so typing one makes the
   code invalid instead of silently turning into a different room.
3. The matchmaking server passes a few setup messages between the two browsers. They then open a
   direct, reliable, ordered WebRTC data channel and send JSON messages over it (spec §14.4). From
   then on, game traffic goes straight from browser to browser. The matchmaking server is only needed
   again to reconnect.
4. To find a route between two home networks, browsers use **STUN** (a server that tells a browser
   its public address). When no direct route exists, they fall back to **TURN**, a relay that forwards
   the traffic. Spur sends a few kilobytes per second, so a relay has little to carry.

Out of the box Spur uses the PeerJS defaults, so there's nothing to set up:

| Piece | Default |
|---|---|
| Matchmaking (signalling) server | the public PeerJS server, `0.peerjs.com` (free, shared, best effort) |
| STUN | Google's public server, `stun:stun.l.google.com:19302` |
| TURN | PeerJS's public relay, `turn:eu-0.turn.peerjs.com:3478` and `turn:us-0.turn.peerjs.com:3478` (best effort) |

### Drops and reconnecting

- If the Engineer's connection drops, the Rider's game pauses and shows "Waiting for the Engineer". Her browser
  tries again every 2 seconds for 60 seconds. When they're back, the host sends the run and a full
  snapshot again, and both players press Ready (spec §14.6).
- How fast a drop is noticed:
  - Closing, reloading or leaving the page is noticed within a fraction of a second: the page says
    goodbye as it goes.
  - A lost network or a crashed browser is noticed through WebRTC's connection checks, after about
    8 seconds.
- If the Rider closes the room on purpose (back to the title screen), the Engineer's browser stops at once
  and shows "The Rider closed the room." It doesn't retry for a minute.
- If the Rider's page reloads, their room can come back under the same code (see `PeerHostOptions.code`
  below). The Engineer's browser finds it again within its 60 seconds.
- There is one the Engineer at a time. A new connection to the room replaces the current one, and the
  replaced browser is told why.

### When players can't connect

What the players see tells you where the problem is:

| Message | Meaning | Fix |
|---|---|---|
| "Can't reach the matchmaking server…" | The signalling server is down, overloaded or blocked (some school, office and public networks block it) | Check the internet connection, or **self-host the PeerServer** (fix 2) |
| Stuck on connecting, then "Couldn't connect to the Rider's browser. Some networks block direct connections between players." | Matchmaking worked, but WebRTC found no route between the two networks (strict NATs, corporate firewalls, some mobile carriers) and the public relay didn't help | **Add a TURN server** (fix 1) |
| "No room with that code…" | A typo, or the room was closed | Check the code with the Rider |

Both fixes are Vite environment variables. They are read when the site is **built**, so change them
and then rebuild and redeploy. Both players must use the same build, which means opening the same URL.

#### Fix 1: add a TURN server

A TURN server relays the connection when the two browsers can't reach each other directly. You can
use a hosted TURN service or run [coturn](https://github.com/coturn/coturn) on any small server with
a public IP address.

Set these, and your TURN server is added to the default STUN and TURN servers:

```ini
VITE_TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
VITE_TURN_USERNAME=spur
VITE_TURN_CREDENTIAL=choose-a-long-password
```

Or replace the whole list with `VITE_ICE_SERVERS`, a JSON array of
[`RTCIceServer`](https://developer.mozilla.org/docs/Web/API/RTCPeerConnection/RTCPeerConnection#iceservers)
objects on one line. You can combine it with `VITE_TURN_*`, which adds one more server to that list.

A minimal coturn setup (`/etc/turnserver.conf`):

```ini
listening-port=3478
tls-listening-port=5349        # for turns: URLs; also set cert= and pkey=
fingerprint
lt-cred-mech
user=spur:choose-a-long-password
realm=turn.example.com
# external-ip=203.0.113.7      # if the server sits behind NAT (e.g. a cloud VM)
```

Open TCP and UDP 3478 and 5349, and the UDP relay range 49152–65535.

Things to know:

- **The credentials are public.** Spur is a static site, so the TURN username and password end up in
  the JavaScript that every player downloads. Use an account that exists only for Spur, and set
  bandwidth or quota limits on the TURN server. Services that only hand out short-lived credentials
  through an API need a small backend, which a static site doesn't have.
- **To check that relaying works**, build with `VITE_ICE_TRANSPORT_POLICY=relay`. Every connection
  then has to go through TURN, so if the players can still connect, your TURN server works. Remove it
  again afterwards. In Chrome, `chrome://webrtc-internals` shows which candidate pair is in use; its
  type is `relay` when TURN carries the traffic.

#### Fix 2: self-host the PeerServer

If the public PeerJS server is down, blocked, or you'd rather not depend on it, run your own
[PeerServer](https://github.com/peers/peerjs-server):

```sh
npx -p peer peerjs --port 9000 --path /spur
# or with Docker:
docker run -p 9000:9000 peerjs/peerjs-server --port 9000 --path /spur
```

Then point the game at it:

```ini
VITE_PEER_HOST=peer.example.com
VITE_PEER_PORT=443
VITE_PEER_PATH=/spur
VITE_PEER_SECURE=true
VITE_PEER_KEY=peerjs
```

Things to know:

- **HTTPS pages need a secure PeerServer.** When the game is served over HTTPS (GitHub Pages,
  itch.io), browsers only allow secure WebSockets. Put the PeerServer behind TLS, for example with
  `caddy reverse-proxy --from peer.example.com --to localhost:9000`. Start PeerServer with
  `--proxied true` when it runs behind a proxy, and set `VITE_PEER_SECURE=true` and
  `VITE_PEER_PORT=443`.
- `VITE_PEER_PATH` must match the server's `--path`, and `VITE_PEER_KEY` its `--key` (default
  `peerjs`).
- `VITE_PEER_HOST=/` means "the same host that serves the game".
- Self-hosting replaces only the matchmaking server. STUN and TURN keep their defaults unless you also
  apply fix 1.

### Environment variables

Every variable is optional. When one is unset, the PeerJS default applies. Invalid values are
ignored with a warning in the browser console.

| Variable | Default | What it does | Example |
|---|---|---|---|
| `VITE_PEER_HOST` | `0.peerjs.com` | PeerServer host name; `/` means the page's own host | `peer.example.com` |
| `VITE_PEER_PORT` | `443` | PeerServer port | `9000` |
| `VITE_PEER_PATH` | `/` | Path the PeerServer is mounted on (its `--path`) | `/spur` |
| `VITE_PEER_SECURE` | `true` for `0.peerjs.com`, otherwise the same as the page (HTTPS page → secure) | Use `wss://` and `https://` to reach the PeerServer (`true`/`false`) | `true` |
| `VITE_PEER_KEY` | `peerjs` | PeerServer API key (its `--key`) | `peerjs` |
| `VITE_ICE_SERVERS` | PeerJS's STUN and TURN servers (table above) | JSON array of `RTCIceServer`; **replaces** the list | `[{"urls":"stun:stun.example.com:3478"}]` |
| `VITE_TURN_URL` | — | One TURN server **added** to the list; several URLs for it may be comma-separated | `turn:turn.example.com:3478` |
| `VITE_TURN_USERNAME` | — | Username for `VITE_TURN_URL` | `spur` |
| `VITE_TURN_CREDENTIAL` | — | Password for `VITE_TURN_URL` | `choose-a-long-password` |
| `VITE_ICE_TRANSPORT_POLICY` | `all` | `relay` forces every connection through TURN (for testing fix 1) | `relay` |
| `VITE_PEER_DEBUG` | `0` | PeerJS console logging, from `0` (none) to `3` (everything) | `3` |

An example `.env.local` in the project root (read by `npm run dev` and `npm run build`):

```ini
# .env.local: local settings, not for git (add "*.local" to .gitignore).

# Fix 1: add a TURN relay (kept next to the default STUN and TURN servers).
VITE_TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
VITE_TURN_USERNAME=spur
VITE_TURN_CREDENTIAL=choose-a-long-password

# Fix 2: use your own PeerServer instead of 0.peerjs.com.
VITE_PEER_HOST=peer.example.com
VITE_PEER_PORT=443
VITE_PEER_PATH=/spur
VITE_PEER_SECURE=true
VITE_PEER_KEY=peerjs

# Alternatively, replace the whole ICE server list (JSON on one line):
# VITE_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"spur","credential":"choose-a-long-password"}]

# Troubleshooting:
# VITE_ICE_TRANSPORT_POLICY=relay
# VITE_PEER_DEBUG=3
```

For the GitHub Pages workflow, store the values as repository variables (or secrets) and pass them
to the build step:

```yaml
      - run: npm run build
        env:
          VITE_TURN_URL: ${{ vars.VITE_TURN_URL }}
          VITE_TURN_USERNAME: ${{ vars.VITE_TURN_USERNAME }}
          VITE_TURN_CREDENTIAL: ${{ secrets.VITE_TURN_CREDENTIAL }}
```

A secret only keeps the value out of the repository. It still ends up in the published JavaScript.

### Testing a connection

`npm run dev` also serves a bare transport test page, which isn't part of the game build:

- `http://localhost:5173/peer-test.html?role=host` opens a room and shows its code.
- `http://localhost:5173/peer-test.html?role=client&code=XXXXX` joins it.

Open them in two browsers, or on two machines using the dev server's `--host` address. Both pages
ping each other every second and show the connection status and round-trip times. A button sends a
100 000-character message to test large messages. Add `retryWindowMs=10000` to the client's URL to
shorten its reconnect window. `chrome://webrtc-internals` (Chrome) and `about:webrtc` (Firefox) show
the WebRTC details.

### For developers

Everything above the `Transport` interface (`src/net/transport.ts`) is the same online and in local
test mode:

- `createLocalPair()` (`src/net/local.ts`) links two in-memory transports for local test mode and
  tests. Messages arrive asynchronously, in order, as JSON copies, like on the wire. `drop()` and
  `restore()` simulate a network failure.
- `PeerHost.open()` (`src/net/peer.ts`) registers a room and resolves with the host. `host.code` is
  the code, and `host.transport` is one stable transport for the whole session: `connecting` until
  the Engineer connects, `open` while they're connected, `closed` when they drop, and `open` again when they
  reconnects. A replaced connection shows as `closed` then `open`. To let a reloaded host keep its
  code, remember it and ask for it again, e.g.
  `PeerHost.open({ code: sessionStorage.getItem('spur.room') ?? undefined })`. If that code is taken,
  a fresh one is used.
- `PeerClient.connect(code)` starts connecting at once. The transport is `connecting`, then `open`.
  After a drop it's `connecting` again while it retries every 2 s for 60 s, then `closed` for good.
  It also goes `closed` for good when the first connection fails, when the host closes the room, or
  on `close()`. `onError` gives the player-facing reason.
- On the wire, messages are JSON (`Msg` in `src/net/protocol.ts`). The transport adds two kinds of
  frames that game code never sees. They have a `spur` field and no `type` field:
  - PeerJS's JSON channel refuses messages of 16 300 bytes or more, so larger messages are split
    into `chunk` frames and put back together on arrival.
  - `bye` frames give the reason a connection is ending: `leaving` (page closing, which counts as a
    drop), `closed` (on purpose) or `replaced`.
- Timings: a drop is noticed when ICE has been `disconnected` for 2.5 s, or at once on a `bye` or
  ICE `failed`. Each connection attempt gets 10 s, and the first connection gets 30 s including
  retries. Registering a room times out after 15 s. After losing the matchmaking server, the host
  re-registers with backoff (1 s up to 15 s) so the Engineer can always come back.
- Saving (`src/save/save.ts`, spec §15) lives next to this. The host's campaign and settings are kept
  under `spur.save.v1`, and the Engineer's own settings under `spur.settings.v1`. A save that can't be
  read, for example one from a newer version, is copied to `spur.save.unreadable` before the game
  falls back to defaults, so it's never lost.
