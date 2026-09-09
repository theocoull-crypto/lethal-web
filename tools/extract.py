"""One-shot asset extraction for LETHAL WEB.

Usage:  python tools/extract.py ["C:\\Path\\To\\Lethal Company"]

1. downloads AssetRipper (official GitHub release) into tools/AssetRipper if missing
2. starts it headless on a local port and loads your own Lethal Company install
3. packs the ship, 41-Experimentation, facility tiles, scrap, hazards, enemies, tools into ./assets
Nothing from the game is committed to the repository: ./assets is gitignored.
"""
import os, sys, subprocess, time, urllib.request, urllib.error, zipfile, json, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AR_DIR = os.path.join(HERE, 'AssetRipper')
AR_EXE = os.path.join(AR_DIR, 'AssetRipper.GUI.Free.exe')
PORT = int(os.environ.get('AR_PORT', '8790'))
RELEASE_API = 'https://api.github.com/repos/AssetRipper/AssetRipper/releases/latest'


def find_game():
    cands = [a for a in sys.argv[1:] if not a.startswith('-')]
    if cands:
        return cands[0]
    for base in (r'C:\Program Files (x86)\Steam', r'C:\Program Files\Steam', os.path.expanduser('~/.steam/steam'), os.path.expanduser('~/Library/Application Support/Steam')):
        p = os.path.join(base, 'steamapps', 'common', 'Lethal Company')
        if os.path.isdir(p):
            return p
        vdf = os.path.join(base, 'steamapps', 'libraryfolders.vdf')
        if os.path.exists(vdf):
            import re
            for m in re.finditer(r'"path"\s+"([^"]+)"', open(vdf, encoding='utf-8', errors='ignore').read()):
                p = os.path.join(m.group(1).replace('\\\\', '\\'), 'steamapps', 'common', 'Lethal Company')
                if os.path.isdir(p):
                    return p
    return None


def ensure_assetripper():
    if os.path.exists(AR_EXE):
        return
    print('Downloading AssetRipper (official release)...')
    d = json.load(urllib.request.urlopen(RELEASE_API, timeout=60))
    asset = next(a for a in d['assets'] if a['name'] == 'AssetRipper_win_x64.zip')
    zpath = os.path.join(HERE, 'AssetRipper_win_x64.zip')
    urllib.request.urlretrieve(asset['browser_download_url'], zpath)
    os.makedirs(AR_DIR, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(AR_DIR)
    os.remove(zpath)
    print('AssetRipper', d['tag_name'], 'ready')


def http(url, data=None, timeout=900):
    req = urllib.request.Request(url, data=data.encode() if isinstance(data, str) else data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'ignore')


def main():
    game = find_game()
    if not game or not os.path.isdir(os.path.join(game, 'Lethal Company_Data')):
        print('Could not find the Lethal Company install. Pass the folder as an argument, e.g.\n  python tools/extract.py "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Lethal Company"')
        sys.exit(1)
    print('Game folder:', game)
    ensure_assetripper()
    log = open(os.path.join(HERE, 'assetripper.log'), 'w')
    proc = subprocess.Popen([AR_EXE, '--headless', '--port', str(PORT), '--log-path', os.path.join(HERE, 'assetripper.file.log')], stdout=log, stderr=log, cwd=AR_DIR)
    try:
        for i in range(60):
            try:
                http(f'http://127.0.0.1:{PORT}/', timeout=5); break
            except Exception:
                time.sleep(1)
        else:
            print('AssetRipper did not start'); sys.exit(1)
        print('Loading game files into AssetRipper (this takes a moment)...')
        import urllib.parse
        http(f'http://127.0.0.1:{PORT}/LoadFolder', data='Path=' + urllib.parse.quote(game))
        # wait until the search works (files processed)
        for i in range(600):
            try:
                if 'Level1Experimentation' in http(f'http://127.0.0.1:{PORT}/Search/View?q=Level1Experimentation', timeout=30):
                    break
            except Exception:
                pass
            time.sleep(2)
        os.environ['AR_BASE'] = f'http://127.0.0.1:{PORT}'
        py = sys.executable
        print('== packing ship + moon')
        subprocess.check_call([py, os.path.join(HERE, 'pack.py'), 'ship', 'moon'], cwd=ROOT)
        print('== packing prefabs (tiles, scrap, enemies, tools)')
        subprocess.check_call([py, os.path.join(HERE, 'pack_prefabs.py')], cwd=ROOT)
        print('== extra clips + bind poses')
        subprocess.check_call([py, os.path.join(HERE, 'pack_extras.py')], cwd=ROOT)
        print('== animation clips')
        subprocess.check_call([py, os.path.join(HERE, 'pack_anims.py')], cwd=ROOT)
        print('\nDone. Run START.bat (or python serve.py) and open http://localhost:8220')
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
