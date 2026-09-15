# LETHAL WEB

A three-moon, single-player "demo" of Lethal Company that runs in a browser (three.js), built from the **real game's own
assets** - the ship, 41-Experimentation, 220-Assurance, 8-Titan, the Company building, the facility and mineshaft
tiles, scrap, hazards and monsters.

**Unofficial, noncommercial fan build.** Lethal Company and its assets belong to Zeekerss; this project is not
affiliated with or endorsed by the developer. This copy includes already-converted runtime files in `./assets` so it
can run on a Chromebook without installing the Windows game. `tools/extract.py` remains available for rebuilding
those files from an owned Steam installation.

## Play

The bundled web build does not require Lethal Company to be installed.

On Windows, run `START.bat` and open http://localhost:8220 in Chrome.

On a Chromebook, enable the Linux development environment, open this repository, choose
**Code -> Download ZIP**, and extract it in Downloads. Then open Terminal and run:

```sh
cd /mnt/chromeos/MyFiles/Downloads/lethal-web-master
python3 serve.py 8220 --no-browser
```

Then open http://localhost:8220 in Chrome. If the extracted folder has a different name, use that name in the `cd`
command. A command-line `git clone https://github.com/theocoull-crypto/lethal-web.git` also works after GitHub
authentication has been configured in the Linux environment.

### Public web and Google Apps Script

The current build is published at https://theocoull-crypto.github.io/lethal-web/.

To make a Google Apps Script web app that loads it, create a script project, copy
`google-apps-script/Code.gs` and `google-apps-script/Index.html` into matching files, then choose **Deploy -> New
deployment -> Web app**. This version does not create a nested GitHub Pages iframe: the game DOM runs directly in the
Apps Script document, its small code runtime loads from the
[`lethal-web-runtime`](https://github.com/theocoull-crypto/lethal-web-runtime) jsDelivr package, and the large binary
assets load from the pinned `lethal-web-assets-v1` CDN tag. When updating an existing Apps Script deployment, create a
new version before redeploying; `Code.gs` uses `XFrameOptionsMode.ALLOWALL` so another page can embed the deployment.

Google's Apps Script sandbox does not grant true Pointer Lock. Direct embedded mode works around that by hiding the
cursor and using relative mouse movement without turning while the mouse is resting; the arrow keys also control the
camera. Press Esc to release it for menus.

To rebuild the extracted game files later, run `python tools/extract.py` on a Windows PC that owns Lethal Company.
It finds the Steam installation, downloads the official [AssetRipper](https://github.com/AssetRipper/AssetRipper)
release, and replaces the converted files in `assets/`.

Controls: WASD move, Shift sprint, Ctrl crouch, Space jump, E interact/grab, G drop, 1-4 or wheel to select, LMB use
item, RMB scan (only tags what is on screen with a clear line of sight - no scanning through walls), F flashlight.

### Playing from another device (a Chromebook, a laptop, a phone)

To stream the installed copy without cloning it, run `START-LAN.bat` instead of `START.bat` - it listens on every
network interface and prints the addresses to open on the other device
(`http://<this PC's IP>:8220`). Same Wi-Fi works directly; from anywhere else, Tailscale on both devices does it
(use the `100.x.x.x` address it prints). Allow Python through the Windows firewall when asked.

## What is in the demo

* The ship runs on its own animation clips from the game: landing and take-off sequences, the sliding doors and their
  open/close buttons, the lever, the light switch. You ride the ship while it moves.
* The terminal works: `help`, `store`, `buy`, `moons`, `route`, `scan`, `quota`. Partial words are fine ("rou exp",
  "the com", "fla"). The store has three items - flashlight, walkie-talkie and shovel - delivered next to the ship
  after landing. The shovel swings with the left mouse button and kills monsters in the same number of hits as the game.
* Ship decor: the store also sells the game's furniture (toilet, shower, table, romantic table, television, record
  player, disco ball, goldfish, plushie, jack-o-lantern, welcome mat, paintings, sofa, fridge, microwave, electric
  chair, dog house). Bought pieces appear on the ship; look at one and press **B** to pick it up, move the mouse to
  carry it, **R** or the wheel to rotate, left click or **B** to put it down. Pieces collide, ride the ship, and their
  layout is remembered in the browser. They also work (E): the record player plays its jazz record, the shower runs,
  the toilet flushes, the romantic table's candles light, the television plays tapes (see below), the fridge
  doors open, the plushie squeaks, the pumpkin can be hit, the electric chair straps rattle, the disco ball spins with
  its lights and the goldfish swims. Every sound and animation is the game's own (the candle flames are drawn here).
* The television plays your own videos: `python tools/pack_tv.py <video files...>` transcodes them to small clips in
  `assets/tv/` with a playlist; switching the set on picks a random tape, static shows while it loads,
  the sound comes out of the set, and the next tape starts when one ends. `serve.py` answers byte-range requests so
  the browser can stream them.
* Ship upgrade: the store sells a **wider ship** ($400) - mborsh's Wider Ship Mod from Thunderstore. Its own hull,
  floor, catwalk, posters and inner-wall beams (packed from the mod's `newship` bundle with
  `python tools/load_mod_bundle.py <newship>` then `python tools/pack_wider_ship.py`) replace the vanilla hull, and the
  props its plugin relocates (ladders, charge station, magnet, machinery, lamps, door panel) move the same way. The
  upgrade is remembered in the browser. The converted runtime files used by this web build are bundled in
  `assets/`.
* Save codes: `save` at the terminal (or the Esc menu) prints one number that holds everything that matters -
  credits, quota progress, days left, the day count, the ship upgrade, how many of each furniture piece and tool you
  own - with two check digits on the end. `load <code>` brings it all back; furniture returns to free deck spots.
  Nothing is written anywhere: the code is the save. Positions, the current moon and the time of day are not in it.
* The Company building: `route company` at the terminal, land, put scrap on the counter, ring the bell. Scrap is
  bought at the game's rate (30% three days out, 100% on the last day) and only sold scrap counts toward the quota.
* Ladders on the moon and the ship can be climbed. Dying makes the ship leave without you.
* The game's low-resolution "pixel" look is reproduced (internal render at 520 lines, nearest-neighbour upscale, grain).
  Press **P** to toggle it.

* The company ship in orbit; route to **41-Experimentation**, **220-Assurance** or **8-Titan** at the terminal and pull
  the lever to land (the real moon geometry, sky and ambience). Each moon uses its own scrap table, enemy list and spawn
  budgets. All routes are free here. Unity terrain heightmaps are exported too (one grid mesh per terrain, with its
  splat layers blended by the alphamaps in a custom material), so terrain moons work.
* Mod moons: a LethalLevelLoader moon can be packed like a mod interior. **127 Eve-M** (RosiePies, Thunderstore) is
  wired in: `python tools/load_mod_bundle.py <evescene.lethalbundle> <evestandalone.lethalbundle>` then
  `set AR_PREFIX=eve && python tools/pack_mod_moon.py eve "Eve1Level (Generated Assets)" EveLevel` packs its scene,
  both terrains and a catalog whose scrap and enemy tables are matched by name to the game's own (the mod references
  vanilla content it cannot ship). A mod's own scrap is packed from its bundle. The moon only appears when its assets
  are present. **115 Wither** (ScienceBird) is wired in the same way: `python tools/load_mod_bundle.py
  <withermoonscene.lethalbundle> <withermoon.lethalbundle> <extrawitherassets>` then
  `set AR_PREFIX=wi && python tools/pack_mod_moon.py wither "WitherScene (Generated Assets)" WitherLevel`. Its scripted
  set pieces (the mod's own plugin) do not come across; its map, scrap and enemy tables do. **42 Tranquillity**
  (NeatWolf): `python tools/load_mod_bundle.py <tranquillitymod.lethalbundle> <tranquillitymodscene.lethalbundle>` then
  `set AR_PREFIX=tq && python tools/pack_mod_moon.py tranquillity "Tranquillity (Generated Assets)" TranquillityLevel`;
  its custom Manor/Facility interior is deliberately not used - the catalog is rewritten to the game's own facility and
  mineshaft tiles at even odds, and its custom enemies (Sandman, GhostBird) and knife scrap are skipped.
* Interiors: the **facility** and the **mineshaft** with its elevator - ride it down to the tunnels and caves, call it
  back from either landing. Experimentation and Assurance roll the interior with the game's own odds (mineshaft ~1% and
  ~12%). Titan is buried in dark fog with snow underfoot and always uses the **Slaughterhouse** interior from Nikki's
  mod of the same name (see below): its vent ducts, pig pens with gates you open, freezer, tanning rooms and grinder.
  The F3 debug menu can force an interior.
* Mod interiors: a LethalLevelLoader interior bundle can be run through the same extractor. With AssetRipper running
  (`tools/extract.py` starts it), `python tools/load_mod_bundle.py <bundle>` loads it next to the game's assemblies,
  `set AR_PREFIX=sh && python tools/pack_mod_interior.py catalog_slaughterhouse.json catalog_titan.json` packs its
  DunGen flow, tiles and doorway parts into the moon's catalog, and `python tools/load_game.py` puts the game back.
  The mod's own scripts (custom events, hazards) do not come across; its rooms, doors, lights, vents and scrap spawns
  do. The converted runtime files used by this web build are bundled in `assets/`.
* Post-processing: light bloom and a cold colour grade (both toggles in Settings), darker facility ambience so lamps and
  the flashlight carry the scene.
* The facility is generated every day from the game's own DunGen tile set (`Level1Flow`): real doorway sockets, tile
  bounds, main path + branches, blockers/doors, vents, prop sets.
* Scrap uses the real spawn table for the moon (rarity, value ranges x 0.4 like the game, weights, two-handed flags).
* Time of day, midnight departure, profit quota with a 3-day deadline, getting fired.
* Moon difficulty: the level's risk letter (D up to S+) multiplies how much scrap spawns and shortens the enemy
  spawn timers, so Titan is far busier than Experimentation. Deep water (the moons' kill volumes) drowns you after
  two seconds under, with a blue wash counting down.
* Monsters use the game's real models, skinning and animation clips (with IK). Every monster with a web behaviour can
  spawn if it is on the moon's real spawn list: Bracken, Thumper, Hoarding bug, Snare flea, Bunker spider, Hygrodere,
  Spore lizard, Ghost girl and Nutcracker inside; Eyeless dogs and Forest keepers outside at night; Manticoils and
  Circuit bees by day. Each behaviour follows the real game's AI: the Bracken sneaks up from behind, freezes when
  looked at and snaps if stared at too long; the Thumper charges fast in straight lines and slows through turns; the
  Hoarding bug gathers scrap into a nest and attacks if you take it; the Snare flea waits on ceilings and drops on you
  (mash E or get outside); the Bunker spider spins webs that slow you and alert it; the Hygrodere is slow and
  unkillable; the Spore lizard puffs a spore cloud and backs away; the Ghost girl haunts you and occasionally chases;
  the Nutcracker only spots movement, then aims, fires its shotgun and reloads; the Eyeless dog is blind and hunts
  by sound (crouch to sneak past); the Forest keeper spots you from far away and eats you. See `js/enemies.js`.

## Debug menu

Press **F3** in-game for the debug panel: god mode, noclip/fly, infinite stamina and battery, frozen enemies, credits, quota, ship land/leave/skip-cutscene, route, a time-of-day slider, teleports (ship, entrance, inside, fire exit, Company counter, random tile), an enemy spawner for every enemy in the catalog, regenerate facility, open all doors, collision wireframe, and live stats (fps, draw calls, triangles, player and ship-local position, tile/door/item/enemy counts).

## How the extraction works

`tools/ar.py` talks to AssetRipper's local web API per asset (no full project export), `tools/walk.py` dumps Unity
hierarchies, `tools/pack.py` converts scenes/prefabs to JSON manifests + GLB meshes (+ rebuilt ProBuilder geometry) +
PNG textures (HDRP mask maps to ORM, normal maps unswizzled) + OGG audio. Transforms are mirrored on X to go from
Unity's left-handed space to glTF/three.js.

## Not included / known gaps

Multiplayer, the terminal store, other moons, the Company building, weather, most enemy animations and several enemies
(Coil-head, Jester, ... are not in Experimentation's spawn list anyway). Performance depends on your GPU: the facility is
rendered as ~40 real tiles.
