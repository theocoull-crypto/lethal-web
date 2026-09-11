"""Pack a LethalLevelLoader moon (its scene + the ExtendedLevel's SelectableLevel) from bundles loaded into AssetRipper with
tools/load_mod_bundle.py.  The scene becomes assets/scenes/<key>.json (Unity terrains included) and the level's scrap /
enemy / outside-object tables are matched BY NAME to the game's own catalogs (the mod references vanilla content it
cannot ship), producing assets/catalog_<key>.json with the facility interior.

Usage:  set AR_PREFIX=eve && python tools/pack_mod_moon.py <key> <scene hierarchy name> <SelectableLevel asset name>
  e.g.  AR_PREFIX=eve python tools/pack_mod_moon.py eve "Eve1Level (Generated Assets)" EveLevel
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get('AR_PREFIX'):
    raise SystemExit('set AR_PREFIX (e.g. eve) so the mod assets get their own ids')
from ar import AR
from pack import Packer, ASSETS

key_name = sys.argv[1] if len(sys.argv) > 1 else 'eve'
scene_name = sys.argv[2] if len(sys.argv) > 2 else 'Eve1Level (Generated Assets)'
level_name = sys.argv[3] if len(sys.argv) > 3 else 'EveLevel'

ar = AR()
pk = Packer(ar)
pk.hier_key = ar.by_name['Prefab Hierarchies']

# 1. the scene
skey = ar.by_name[scene_name]
out_scene = os.path.join(ASSETS, 'scenes', key_name + '.json')
print('== scene', scene_name)
pk.pack_hierarchy(skey, 1, out_scene, prune={'ConstructingLevelTiles', 'TestRoom', 'Editor', 'OutOfBoundsColliders', 'Cutscenes', 'ItemShipAnimContainer'})

# 2. the level data, by name against the vanilla catalogs
def find_level():
    for name, key in ar.by_name.items():
        c = ar.coll(key)
        for pid, v in c.assets.items():
            if v[0] == 'MonoBehaviour' and v[1] == level_name:
                return key, pid
    return None, None

lkey, lpid = find_level()
if lkey is None:
    raise SystemExit('SelectableLevel ' + level_name + ' not found')
lv = ar.json(lkey, lpid)['m_Structure']

vanilla = {}
for fn in ('catalog.json', 'catalog_assurance.json', 'catalog_titan.json'):
    fp = os.path.join(ASSETS, fn)
    if os.path.exists(fp):
        vanilla[fn] = json.load(open(fp, encoding='utf-8'))
base = vanilla.get('catalog.json') or next(iter(vanilla.values()))

def named(pptr):
    r = ar.resolve(lkey, pptr)
    if not r:
        return None
    try:
        j = ar.json(*r)
    except Exception:
        return None
    st = j.get('m_Structure') or {}
    return st.get('itemName') or st.get('enemyName') or j.get('m_Name') or ar.name(*r)

scrap = []
for e in lv.get('spawnableScrap') or []:
    nm = named(e.get('spawnableItem'))
    hit = None
    for cat in vanilla.values():
        hit = next((s for s in cat.get('scrap', []) if s.get('itemName') == nm or s.get('name') == nm), None)
        if hit:
            break
    if hit:
        s = dict(hit); s['rarity'] = e.get('rarity', 1); scrap.append(s)
    else:
        print('   scrap not in the game catalogs (custom or renamed):', nm)
print('scrap entries', len(scrap))

enemies = {'inside': [], 'outside': [], 'daytime': []}
for group, src in (('inside', 'Enemies'), ('outside', 'OutsideEnemies'), ('daytime', 'DaytimeEnemies')):
    for e in lv.get(src) or []:
        nm = named(e.get('enemyType'))
        hit = None
        for cat in vanilla.values():
            for g in ('inside', 'outside', 'daytime'):
                hit = next((x for x in cat.get('enemies', {}).get(g, []) if x.get('enemyName') == nm or x.get('name') == nm), None)
                if hit:
                    break
            if hit:
                break
        if hit:
            x = dict(hit); x['rarity'] = e.get('rarity', 1); enemies[group].append(x)
        else:
            print('   enemy not in the game catalogs:', nm)
print('enemies', {k: len(v) for k, v in enemies.items()})

outside = []
for e in lv.get('spawnableOutsideObjects') or []:
    nm = named(e.get('spawnableObject'))
    hit = None
    for cat in vanilla.values():
        hit = next((x for x in cat.get('outsideObjects', []) if x.get('name') == nm), None)
        if hit:
            break
    if hit:
        x = dict(hit); x['randomAmount'] = e.get('randomAmount', x.get('randomAmount')); outside.append(x)
    else:
        print('   outside object not in the game catalogs:', nm)

flows = {}
for f in lv.get('dungeonFlowTypes') or []:
    fid = f.get('id')
    src = {0: 'Level1Flow', 4: 'Level3Flow'}.get(fid)
    if src and src in base.get('flows', {}):
        flows[src] = dict(base['flows'][src]); flows[src]['rarity'] = f.get('rarity', 100)
if not flows and base.get('flows'):
    flows = {'Level1Flow': dict(base['flows']['Level1Flow'])}

cat = {k: base[k] for k in ('tiles', 'tileSets', 'flow', 'hazards', 'tools', 'doorParts') if k in base}
cat.update({'flows': flows, 'scrap': scrap, 'enemies': enemies, 'outsideObjects': outside,
            'level': {k: lv.get(k) for k in ('PlanetName', 'LevelDescription', 'riskLevel', 'minScrap', 'maxScrap', 'minTotalScrapValue', 'maxTotalScrapValue', 'maxEnemyPowerCount', 'maxOutsideEnemyPowerCount', 'maxDaytimeEnemyPowerCount', 'factorySizeMultiplier')},
            'levelKey': key_name, 'modMoon': True})
out_cat = os.path.join(ASSETS, 'catalog_' + key_name + '.json')
json.dump(cat, open(out_cat, 'w', encoding='utf-8'))
pk.flush()
print('wrote', out_scene, 'and', out_cat, '|', lv.get('PlanetName'))
