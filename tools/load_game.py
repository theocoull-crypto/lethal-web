"""Put the game install back into the running AssetRipper after a mod bundle was loaded."""
import os, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import find_game, http, PORT

game = find_game()
if not game:
    raise SystemExit('Lethal Company install not found')
t0 = time.time()
http(f'http://127.0.0.1:{PORT}/LoadFolder', data='Path=' + urllib.parse.quote(game))
print('AssetRipper reloaded the game in', round(time.time() - t0, 1), 's')
