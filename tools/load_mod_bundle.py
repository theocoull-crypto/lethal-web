"""Load a mod's interior asset bundle into the running AssetRipper (started by tools/extract.py) next to the game's own
assemblies, so DunGen tile data deserialises.  Usage:
    python tools/load_mod_bundle.py <path\\to\\bundle.lethalbundle>
Afterwards run  python tools/pack_mod_interior.py <flow name> <moon>  and then  python tools/load_game.py  to put the
game files back in AssetRipper."""
import os, sys, shutil, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import find_game, http, PORT

# popped: find_game() reads argv[1] as a game path.  Several bundles (a mod's scene + standalone bundle) load together.
bundles = []
while len(sys.argv) > 1 and not sys.argv[1].startswith('-'):
    bundles.append(sys.argv.pop(1))
bundle = bundles[0] if bundles else os.path.join('dump', 'mods', 'slaughterhouse', 'plugins', 'Slaughterhouse', 'slaughterhouseinterior.lethalbundle')
game = find_game()
if not game:
    raise SystemExit('Lethal Company install not found')
managed = os.path.join(game, 'Lethal Company_Data', 'Managed')
dst = os.path.abspath(os.path.join('dump', 'ar_mod'))
os.makedirs(os.path.join(dst, 'Managed'), exist_ok=True)
n = 0
for f in os.listdir(managed):
    if f.lower().endswith('.dll') and not os.path.exists(os.path.join(dst, 'Managed', f)):
        shutil.copy2(os.path.join(managed, f), os.path.join(dst, 'Managed', f)); n += 1
# one bundle at a time: AssetRipper resolves a bundle's pointers through 'the' cab- data collection
if not bundles:
    bundles = [bundle]
keep = {os.path.basename(b) for b in bundles}
for f in os.listdir(dst):
    fp = os.path.join(dst, f)
    if os.path.isfile(fp) and f not in keep:
        os.remove(fp)
for b in bundles:
    shutil.copy2(b, os.path.join(dst, os.path.basename(b)))
print('game assemblies copied:', n, '| bundle:', os.path.basename(bundle), '| load folder:', dst)
t0 = time.time()
http(f'http://127.0.0.1:{PORT}/LoadFolder', data='Path=' + urllib.parse.quote(dst))
print('AssetRipper loaded the folder in', round(time.time() - t0, 1), 's')
time.sleep(1)
from ar import AR
ar = AR()
print('collections now:', len(ar.by_name), sorted(ar.by_name.keys())[:30])
