"""Extra clips that are not referenced by any packed component, bind poses for skinned meshes, JSON sanitising."""
import sys, os, json, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ar import AR
from pack import Packer, ASSETS

ar = AR()
pk = Packer(ar)
EXTRA_AUDIO = {'b8_1757': 'FactoryAmbience1', 'b7_174': 'WindOutside', 'b7_164': 'FactoryWindAmbiance', 'b8_1520': 'v50ShipWind'}
for aid, name in EXTRA_AUDIO.items():
    try:
        k, p = pk.kp(aid)
        pk.ar.save('audio', k, p, os.path.join(ASSETS, 'audio', aid + '.ogg'))
    except Exception as e:
        # ids can differ between game versions: fall back to a name search
        hits = [h for h in ar.search(name) if h[2] == 'AudioClip' and h[3] == name]
        if hits:
            pk.ar.save('audio', hits[0][0], hits[0][1], os.path.join(ASSETS, 'audio', aid + '.ogg'))
        else:
            print('  !! missing clip', name)
for f in glob.glob(os.path.join(ASSETS, 'prefabs', '*.json')) + glob.glob(os.path.join(ASSETS, 'scenes', '*.json')):
    m = json.load(open(f, encoding='utf-8'))
    for n in m['nodes']:
        for c in n['comps']:
            if c['t'] == 'SMR' and c['mesh']:
                pk.skinned.add(c['mesh'])
pk.flush()
n = 0
for f in glob.glob(os.path.join(ASSETS, '**', '*.json'), recursive=True):
    s = open(f, encoding='utf-8').read()
    if 'Infinity' in s.replace('m_PreInfinity', '').replace('m_PostInfinity', '') or ': NaN' in s or ':NaN' in s:
        s = s.replace('-Infinity', '-1e30').replace(': Infinity', ': 1e30').replace(':Infinity', ':1e30').replace(': NaN', ': 0').replace(':NaN', ':0')
        open(f, 'w', encoding='utf-8').write(s); n += 1
print('sanitised', n, 'json files;', len(pk.skinned), 'skinned meshes')
