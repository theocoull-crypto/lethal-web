"""Pack the ship decor (furniture) from StartOfRound.unlockablesList: every placeable unlockable with a prefab.
Writes assets/prefabs/<Name>__<aid>.json (+ meshes/textures/clips) and assets/decor.json with the store list.
Prices: the terminal's decor nodes are not reachable through the packed node list, so the game's known prices are
listed here (newer items get sensible guesses).  Run with the game loaded in AssetRipper (tools/extract.py)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ar import AR
from pack import Packer, ASSETS

PRICES = {'Cozy lights': 140, 'Television': 500, 'Toilet': 100, 'Shower': 190, 'Record player': 180, 'Table': 70,
          'Romantic table': 150, 'JackOLantern': 150, 'Welcome mat': 60, 'Goldfish': 70, 'Plushie pajama man': 200,
          'Disco Ball': 280, 'Microwave': 60, 'Sofa chair': 180, 'Fridge': 120, 'Classic painting': 55,
          'Electric chair': 190, 'Dog house': 145}
SKIP = {'Teleporter', 'Inverse Teleporter', 'Signal translator', 'Loud horn'}   # ship upgrades need their own mechanics

ar = AR()
pk = Packer(ar)
b8 = ar.key_by_id['b8']
OUT = os.path.join(ASSETS, 'prefabs')
os.makedirs(OUT, exist_ok=True)


def safe(name):
    return ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in name)


ul = ar.json(b8, 34866)['m_Structure']
decor = []
for i, u in enumerate(ul.get('unlockables') or []):
    if u.get('unlockableType') != 1 or not u.get('IsPlaceable'):
        continue
    name = u.get('unlockableName')
    if name in SKIP:
        continue
    pf = u.get('prefabObject'); r = ar.resolve(b8, pf) if pf and pf.get('m_PathID') else None
    if not r:
        continue   # things that already exist on the ship (cupboard, terminal, bunkbeds...)
    aid = ar.aid(*r)
    fn = f'{safe(ar.name(*r))}__{aid}.json'
    res = pk.pack_prefab(aid, os.path.join(OUT, fn))
    if not res:
        print('  !! could not pack', name); continue
    # placement data from the PlaceableShipObject component
    place = {}
    for n in res['nodes']:
        for c in n['comps']:
            if c['t'] == 'MB' and c['cls'].endswith('PlaceableShipObject') and c.get('d'):
                d = c['d']
                place = {k: d.get(k) for k in ('AllowPlacementOnWalls', 'AllowPlacementOnCounters', 'allowPlacementOnWalls', 'allowPlacementOnCounters', 'unlockableID', 'placeObjectSFX', 'doNotAllowPlacement')}
                place['node'] = n['id']
    decor.append({'id': i, 'name': name, 'prefab': fn, 'price': PRICES.get(name, 100), 'place': place})
    print('  decor', i, name, '->', fn, '$', PRICES.get(name, 100))

json.dump(decor, open(os.path.join(ASSETS, 'decor.json'), 'w', encoding='utf-8'), indent=1)
pk.flush()
print('decor packed:', len(decor))
