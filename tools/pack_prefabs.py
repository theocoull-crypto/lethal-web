"""Pack every prefab the Experimentation 'demo' needs: facility tiles for Level1Flow, doorway connectors/blockers,
scrap items, hazards, enemies, outside props, tools, and the player model. Writes assets/prefabs/<name>.json"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ar import AR
from pack import Packer, ASSETS

ar = AR()
pk = Packer(ar)
b8 = ar.key_by_id['b8']
OUT = os.path.join(ASSETS, 'prefabs')
os.makedirs(OUT, exist_ok=True)
catalog = {'tiles': {}, 'tileSets': {}, 'flow': None, 'scrap': [], 'hazards': [], 'enemies': {'inside': [], 'outside': [], 'daytime': []}, 'outsideObjects': [], 'tools': {}, 'doorParts': [], 'level': {}}


def safe(name):
    return ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in name)


packed = {}
def pack_go(aid, tag=None):
    """Pack the prefab whose root GameObject is aid. Returns manifest file name."""
    if aid in packed:
        return packed[aid]
    idx = pk.build_prefab_index()
    if aid not in idx:
        print('  !! no prefab hierarchy for', aid, pk.ref(aid))
        packed[aid] = None
        return None
    name = safe(pk.ref(aid)[1])
    fn = f'{name}__{aid}.json'
    res = pk.pack_prefab(aid, os.path.join(OUT, fn))
    packed[aid] = fn
    # follow DunGen doorway connector / blocker prefabs
    for n in res['nodes']:
        for c in n['comps']:
            if c['t'] == 'MB' and c['cls'] == 'Doorway' and 'd' in c:
                for grp in ('ConnectorPrefabWeights', 'BlockerPrefabWeights'):
                    for w in c['d'].get(grp, []) or []:
                        go = w.get('GameObject')
                        if go and go.get('c') == 'GameObject':
                            sub = pack_go(go['$'])
                            if sub and sub not in catalog['doorParts']:
                                catalog['doorParts'].append(sub)
            if c['t'] == 'MB' and c['cls'] in ('SpawnSyncedObject',) and 'd' in c:
                go = (c['d'].get('spawnPrefab') or {})
                if go and go.get('c') == 'GameObject':
                    sub = pack_go(go['$'])
                    if sub and sub not in catalog['doorParts']:
                        catalog['doorParts'].append(sub)
    return fn


def ref_aid(pptr, key):
    r = ar.resolve(key, pptr)
    return ar.aid(*r) if r else None


# ---- dungeon flow ----
flow = ar.json(b8, 34480)['m_Structure']
catalog['flow'] = {'Length': flow['Length'], 'BranchCount': flow['BranchCount'], 'BranchMode': flow['BranchMode'],
                   'DoorwayConnectionChance': flow.get('DoorwayConnectionChance'), 'GlobalProps': flow.get('GlobalProps'),
                   'nodes': [], 'lines': []}
def tileset(pp, key):
    r = ar.resolve(key, pp)
    ts = ar.json(*r)['m_Structure']
    name = ar.name(*r)
    if name not in catalog['tileSets']:
        entries = []
        for w in ts['TileWeights']['Weights']:
            go = ref_aid(w['Value'], r[0])
            if not go:
                continue
            fn = pack_go(go)
            if fn:
                curve = [(k['time'], k['value']) for k in (w.get('DepthWeightScale', {}) or {}).get('m_Curve', [])]
                entries.append({'prefab': fn, 'main': w.get('MainPathWeight', 1), 'branch': w.get('BranchPathWeight', 1), 'depthCurve': curve})
        catalog['tileSets'][name] = entries
    return name
for n in flow['Nodes']:
    catalog['flow']['nodes'].append({'label': n.get('Label'), 'pos': n.get('Position'), 'type': n.get('NodeType'), 'tileSets': [tileset(t, b8) for t in n.get('TileSets', [])]})
for l in flow['Lines']:
    arch = []
    for a in l.get('DungeonArchetypes', []):
        r = ar.resolve(b8, a); aj = ar.json(*r)['m_Structure']
        arch.append({'name': ar.name(*r), 'tileSets': [tileset(t, r[0]) for t in aj.get('TileSets', [])],
                     'branchStart': [tileset(t, r[0]) for t in aj.get('BranchStartTileSets', [])],
                     'branchCap': [tileset(t, r[0]) for t in aj.get('BranchCapTileSets', [])],
                     'branchCapType': aj.get('BranchCapType'), 'straighten': aj.get('StraightenChance'),
                     'branchStartType': aj.get('BranchStartType')})
    catalog['flow']['lines'].append({'pos': l.get('Position'), 'len': l.get('Length'), 'archetypes': arch})

# ---- level data ----
lvl = ar.json(b8, 34533)['m_Structure']
catalog['level'] = {k: lvl.get(k) for k in ('PlanetName', 'LevelDescription', 'riskLevel', 'minScrap', 'maxScrap', 'minTotalScrapValue', 'maxTotalScrapValue',
                                              'maxEnemyPowerCount', 'maxOutsideEnemyPowerCount', 'maxDaytimeEnemyPowerCount', 'timeToArrive',
                                              'DaySpeedMultiplier', 'planetHasTime', 'enemySpawnChanceThroughoutDay', 'outsideEnemySpawnChanceThroughDay',
                                              'daytimeEnemySpawnChanceThroughDay', 'spawnProbabilityRange', 'daytimeEnemiesProbabilityRange')}
catalog['level']['ambience'] = []
for a in lvl.get('levelAmbienceClips', {}).get('m_FileID', None) and [] or []:
    pass
amb = ar.resolve(b8, lvl.get('levelAmbienceClips'))
if amb:
    aj = ar.json(*amb)['m_Structure']
    for grp in ('insideAmbience', 'outsideAmbience', 'shipAmbience'):
        pass
    catalog['level']['ambienceData'] = pk.resolve_refs(amb[0], aj)

for s in lvl['spawnableScrap']:
    r = ar.resolve(b8, s['spawnableItem']); it = ar.json(*r)['m_Structure']
    go = ref_aid(it['spawnPrefab'], r[0])
    fn = pack_go(go) if go else None
    entry = {'name': ar.name(*r), 'itemName': it.get('itemName'), 'rarity': s['rarity'], 'prefab': fn,
             'minValue': it.get('minValue'), 'maxValue': it.get('maxValue'), 'weight': it.get('weight'), 'twoHanded': it.get('twoHanded'),
             'isConductiveMetal': it.get('isConductiveMetal'), 'floorYOffset': it.get('floorYOffset'), 'verticalOffset': it.get('verticalOffset'),
             'restingRotation': it.get('restingRotation'), 'rotationOffset': it.get('rotationOffset'), 'positionOffset': it.get('positionOffset'),
             'grabSFX': pk.resolve_refs(r[0], it.get('grabSFX')), 'dropSFX': pk.resolve_refs(r[0], it.get('dropSFX')),
             'itemIcon': None, 'usable': it.get('itemIsTrigger'), 'toolTips': it.get('toolTips'), 'isScrap': it.get('isScrap')}
    catalog['scrap'].append(entry)
    print('  scrap', entry['name'], fn)

for m in lvl['spawnableMapObjects']:
    go = ref_aid(m['prefabToSpawn'], b8)
    fn = pack_go(go) if go else None
    catalog['hazards'].append({'prefab': fn, 'curve': [(k['time'], k['value']) for k in m.get('numberToSpawn', {}).get('m_Curve', [])],
                               'spawnFacingAwayFromWall': m.get('spawnFacingAwayFromWall'), 'requireDistanceBetweenSpawns': m.get('requireDistanceBetweenSpawns')})

for grp, key in (('inside', 'Enemies'), ('outside', 'OutsideEnemies'), ('daytime', 'DaytimeEnemies')):
    for e in lvl[key]:
        r = ar.resolve(b8, e['enemyType']); et = ar.json(*r)['m_Structure']
        go = ref_aid(et['enemyPrefab'], r[0])
        fn = pack_go(go) if go else None
        catalog['enemies'][grp].append({'name': ar.name(*r), 'enemyName': et.get('enemyName'), 'rarity': e['rarity'], 'prefab': fn,
                                        'power': et.get('PowerLevel'), 'maxCount': et.get('MaxCount'),
                                        'probCurve': [(k['time'], k['value']) for k in et.get('probabilityCurve', {}).get('m_Curve', [])],
                                        'isOutside': et.get('isOutsideEnemy'), 'isDaytime': et.get('isDaytimeEnemy'),
                                        'canDie': et.get('canDie'), 'stunTime': et.get('stunTimeMultiplier'), 'doorSpeed': et.get('doorSpeedMultiplier'),
                                        'sfx': pk.resolve_refs(r[0], {k: et.get(k) for k in ('hitBodySFX', 'hitEnemyVoiceSFX', 'deathSFX', 'stunSFX', 'audioClips', 'overrideVentSFX')})})
        print('  enemy', grp, ar.name(*r), fn)

for m in lvl['spawnableOutsideObjects']:
    r = ar.resolve(b8, m['spawnableObject']); so = ar.json(*r)['m_Structure']
    go = ref_aid(so['prefabToSpawn'], r[0])
    fn = pack_go(go) if go else None
    catalog['outsideObjects'].append({'name': ar.name(*r), 'prefab': fn, 'width': so.get('objectWidth'), 'spawnFacingAwayFromWall': so.get('spawnFacingAwayFromWall'),
                                      'curve': [(k['time'], k['value']) for k in m.get('randomAmount', {}).get('m_Curve', [])]})

# ---- tools / misc by prefab name ----
idx = pk.build_prefab_index()
for nm in ('FlashlightItem', 'WalkieTalkie', 'ShovelItem', 'Key', 'LockPickerItem', 'BBFlashlight', 'StunGrenade', 'ExtensionLadderItem', 'BoomboxItem', 'SprayPaintItem', 'ClipboardManual', 'StickyNoteItem'):
    if nm in idx:
        g0 = ar.key_by_id['g0']
        h = ar.json(g0, idx[nm]); r = ar.resolve(g0, h['Root'])
        fn = pack_go(ar.aid(*r))
        catalog['tools'][nm] = fn
        # item data lives in a GrabbableObject MB -> itemProperties ref (Item scriptable object)
        man = json.load(open(os.path.join(OUT, fn), encoding='utf-8'))
        for n in man['nodes']:
            for c in n['comps']:
                if c['t'] == 'MB' and 'd' in c and isinstance(c['d'].get('itemProperties'), dict):
                    ip = c['d']['itemProperties']
                    k, p = pk.kp(ip['$']); it = ar.json(k, p)['m_Structure']
                    catalog['tools'][nm + '_item'] = pk.resolve_refs(k, {kk: it.get(kk) for kk in ('itemName', 'weight', 'twoHanded', 'grabSFX', 'dropSFX', 'toolTips', 'requiresBattery', 'batteryUsage', 'itemIsTrigger', 'holdButtonUse', 'creditsWorth', 'restingRotation', 'rotationOffset', 'positionOffset', 'verticalOffset', 'floorYOffset')})
                    break

# ---- player + systems from the ship scene ----
pk.pack_hierarchy(ar.key_by_id['g9'], 1, os.path.join(ASSETS, 'scenes', 'player.json'), root_filter={'Player (1)'})
pk.pack_hierarchy(ar.key_by_id['g9'], 1, os.path.join(ASSETS, 'scenes', 'systems.json'), root_filter={'Systems'},
                  prune={'UI', 'Canvas', 'PlayerScreen'})

open(os.path.join(ASSETS, 'catalog.json'), 'w', encoding='utf-8').write(json.dumps(catalog, indent=1).replace('-Infinity', '-1e30').replace('Infinity', '1e30').replace('NaN', '0'))
pk.flush()
print('prefabs done:', len([v for v in packed.values() if v]))
