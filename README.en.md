# Lakeside Fishing
### 湖畔のフィッシング

English | **[日本語](README.md)**

**Cast a line into the dawn-lit lake, and wait.**  
They say the *Lord of the Lake* still sleeps in its deepest waters.

### ▶ [Play in your browser](https://teitasan.github.io/ThreeJs-Fishing-Game/)

No installation needed — everything runs in the browser. Sound on. Best with a mouse on desktop.  
Available in **Japanese / English** (switch from the title screen or the in-game menu). The GitHub Pages build is single-player only. Multiplayer is available on the Cloudflare Worker–hosted build (Worker URL is not public).

![Lakeside Fishing](docs/screenshot.png)

<p>
<img src="docs/firstperson.png" width="32.5%" alt="First person">
<img src="docs/underwater.png" width="32.5%" alt="Underwater camera">
<img src="docs/journal.png" width="32.5%" alt="Journal">
</p>
<p>
<img src="docs/cast.png" width="49%" alt="Casting">
<img src="docs/fight.png" width="49%" alt="Fight">
</p>

---

## What is this?

A 3D fishing game built around quiet angling: walk the lakeshore, pick your depth and bait, cast, and wait.

- **Aim and cast** — look down for short casts, level out for long ones. Release inside the green band to hit your mark
- **Location and depth matter** — shallows vs. deep water, surface vs. mid-column vs. bottom. Every fish has its own haunt
- **Fight by feel and sound** — hold to reel, give line when it runs. The rod bends and kicks with every move the fish makes
- **Journal and surveying** — collect fish and terrain; the map fills in only where you've walked or cast
- **A different lake every time** — seed-generated. Day/night and weather change what bites
- **Upgrade your gear** — rods, lines, baits. Higher tiers unlock as you level up

| | |
| --- | --- |
| Fish & critters | 30 species + 4 kinds of junk |
| Gear | 5 rods / 9 lines / 7 baits |
| Achievements | 9 |
| Perspective | First person + underwater camera |
| Languages | Japanese / English |

---

## How to play (in one breath)

1. **Aim with the mouse**, then press and release inside the green band to cast
2. Pick a depth layer (surface / mid / bottom) with **`E`**
3. When the bobber goes under, **click immediately** to set the hook
4. During the fight: **hold to reel** / **release to ease the tension**
5. Catches earn money and XP. `B` opens the shop, `Q` the journal

For detailed parameters and the simulator, see the [Parameter Guide](https://teitasan.github.io/ThreeJs-Fishing-Game/manual.html) (Japanese).

---

## Controls

| | |
| --- | --- |
| Look | Mouse (click to lock / Esc to release) |
| Move / sprint | `W` `A` `S` `D` / `Shift` |
| Cast · hook · reel | Click or `Space` |
| Depth layer | `E` |
| Journal / Shop / Map | `Q` / `B` / `M` |
| Underwater camera | `V` (while the rig is underwater) |
| Toggle UI / Menu | `U` / `Esc` |

You can switch the language from the title screen or the in-game menu.

---

## Tips

- Match water depth with the right layer. The `E` panel lists "fish that bite here"
- Big fish will snap an underpowered line. Lines = strength; rods = reeling power and stamina
- Night, rain, deep water, premium bait. The rumored **Lord of the Lake** and the **Taimen (Itou)** are waiting there
- Use "Take a Break" in the menu to advance time by one hour

---

## Running locally

```bash
./serve.sh
# or: python3 -m http.server 8000
```

Open `http://localhost:8000`. It won't run from `file://`. A WebGL2-capable browser is recommended.
**Single-player only** on a static server. Use the Worker below for multiplayer.

### Multiplayer Worker (Node.js 22 recommended)

```bash
npm install
npm run dev:mp
# or: npx wrangler dev --local --persist-to /tmp/lakeside-fishing-wrangler-state
```

Open `http://localhost:8787` and choose **Play Together** on the title screen.
The Worker serves the game and `/ws` / `/api/voice/join` on the same origin.

```bash
node scripts/run-tests.mjs
node scripts/run-mp-protocol-test.mjs
```

---

## Deployment architecture

| Role | Host | Serves |
| --- | --- | --- |
| Single-player | [GitHub Pages](https://teitasan.github.io/ThreeJs-Fishing-Game/) | Static HTML / JS / assets (no multiplayer UI) |
| Multiplayer | Cloudflare Worker | Full game + `/ws` + `/api/voice/join` (same origin) |

Pushes to `main` deploy GitHub Pages and the Worker independently.

### GitHub Pages (single-player)

- Workflow: `.github/workflows/deploy-pages.yml`
- Project-site base path: `/ThreeJs-Fishing-Game/` (relative `./` paths resolve correctly)
- **Play Together** is hidden and no WebSocket connection is attempted.

### Cloudflare Worker (multiplayer)

- Workflow: `.github/workflows/deploy-cloudflare.yml` (`wrangler deploy --env production`)
- Serves static assets and multiplayer APIs from the same Worker.
- Security is **URL obscurity**: anyone who knows the Worker URL may join.

Secret: `REALTIMEKIT_API_TOKEN` (via `wrangler secret put`, as before).

---

## Credits

- Angler & rod models: [Quaternius](https://quaternius.com/) (CC0)
- Engine: Three.js (bundled in-repo, no external requests)
- Post-processing: [postprocessing](https://github.com/pmndrs/postprocessing) (bundled in-repo)

Single-player → [teitasan.github.io/ThreeJs-Fishing-Game](https://teitasan.github.io/ThreeJs-Fishing-Game/)
