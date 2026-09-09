# LETHAL WEB

A single-moon, single-player "demo" of Lethal Company that runs in a browser (three.js), built from the **real game's own
assets** - the ship, 41-Experimentation, the facility tiles, scrap, hazards and monsters - pulled straight out of *your*
Steam install at extraction time.

**No game content is in this repository.** Lethal Company belongs to Zeekerss. You need to own the game on Steam;
`tools/extract.py` reads your local copy and writes the converted assets into `./assets`, which is gitignored.
This is a fan project in the same spirit as open-source engine reimplementations that need the original data files.

## Play

1. Install Python 3.10+ (Windows: python.org, tick "Add to PATH").
2. `python tools/extract.py` - finds your Steam copy of Lethal Company, downloads the official
   [AssetRipper](https://github.com/AssetRipper/AssetRipper) release, and packs everything into `assets/` (about 2 minutes, ~150 MB).
   If your game is somewhere unusual: `python tools/extract.py "D:\Games\Lethal Company"`.
3. `START.bat` (or `python serve.py`) and open http://localhost:8220 in Chrome.

Controls: WASD move, Shift sprint, Ctrl crouch, Space jump, E interact/grab, G drop, 1-4 or wheel to select, LMB use
item, RMB scan, F flashlight.

## What is in the demo

* The company ship in orbit; pull the lever to land on **41-Experimentation** (the real moon geometry, sky and ambience).
* The facility is generated every day from the game's own DunGen tile set (`Level1Flow`): real doorway sockets, tile
  bounds, main path + branches, blockers/doors, vents, prop sets.
* Scrap uses the real spawn table for the moon (rarity, value ranges x 0.4 like the game, weights, two-handed flags).
* Time of day, midnight departure, profit quota with a 3-day deadline, getting fired.
* Monsters from the moon's actual spawn lists: Bracken, Thumper, Hoarding bug, Snare flea, Bunker spider, Hygrodere,
  Spore lizard, Ghost girl, Nutcracker inside; Eyeless dogs and Forest keepers outside at night. Behaviours are simplified
  re-implementations (no navmesh, no animation rig) - see `js/enemies.js`.

## How the extraction works

`tools/ar.py` talks to AssetRipper's local web API per asset (no full project export), `tools/walk.py` dumps Unity
hierarchies, `tools/pack.py` converts scenes/prefabs to JSON manifests + GLB meshes (+ rebuilt ProBuilder geometry) +
PNG textures (HDRP mask maps to ORM, normal maps unswizzled) + OGG audio. Transforms are mirrored on X to go from
Unity's left-handed space to glTF/three.js.

## Not included / known gaps

Multiplayer, the terminal store, other moons, the Company building, weather, most enemy animations and several enemies
(Coil-head, Jester, ... are not in Experimentation's spawn list anyway). Performance depends on your GPU: the facility is
rendered as ~40 real tiles.
