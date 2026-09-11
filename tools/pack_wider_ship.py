"""Pack the Wider Ship Mod's ship parts (ShipBoth, wall_left, wall_right, Plane.001Both) from its 'newship' bundle,
loaded into AssetRipper with  python tools/load_mod_bundle.py dump/mods/widership/newship
Usage:  set AR_PREFIX=ws && python tools/pack_wider_ship.py      -> assets/prefabs/<name>__ws*.json + assets/widership.json"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('AR_PREFIX', 'ws')
from ar import AR
from pack import Packer, ASSETS

WANT = ['ShipBoth', 'wall_left', 'wall_right', 'Plane.001Both']
ar = AR(); pk = Packer(ar)
pk.hier_key = ar.by_name['Prefab Hierarchies']
OUT = os.path.join(ASSETS, 'prefabs'); os.makedirs(OUT, exist_ok=True)
idx = pk.build_prefab_index()
names = {}
for aid, v in idx.items():
    try:
        r = pk.ref(aid)
    except Exception:
        continue
    if r and r[0] == 'GameObject':
        names[r[1]] = aid
print('prefab roots:', sorted(names))
out = {}
for w in WANT:
    aid = names.get(w)
    if not aid:
        print('  !! missing', w); continue
    fn = f"{''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in w)}__{aid}.json"
    res = pk.pack_prefab(aid, os.path.join(OUT, fn))
    print('  packed', w, '->', fn, 'nodes', len(res['nodes']) if res else 0)
    out[w] = fn
pk.flush()
json.dump(out, open(os.path.join(ASSETS, 'widership.json'), 'w', encoding='utf-8'), indent=1)
print('wrote assets/widership.json')
