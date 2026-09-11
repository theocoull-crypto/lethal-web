"""Build the ship television's playlist: transcode the user's own analog-horror videos to small 4:3 clips in
assets/tv/ (gitignored, like everything else in assets) and write assets/tv/index.json.
Usage: python tools/pack_tv.py            (uses the SOURCES list below; missing files are skipped)
       python tools/pack_tv.py a.mp4 b.mp4 (adds these files instead)"""
import json, os, re, subprocess, sys

HOME = os.path.expanduser('~')
DL = os.path.join(HOME, 'Downloads')
SOURCES = [
    os.path.join(HOME, 'analog-horror', 'REEL_7_SAFETY_AND_YOU.mp4'),
    os.path.join(HOME, 'analog-horror', 'EMERGENCY_BROADCAST.mp4'),
    os.path.join(DL, 'ONE_OF_YOUR_CLASSMATES_IS_NOT_REAL.mp4'),
    os.path.join(DL, 'ESTABLISHING_CONTACT.mp4'),
    os.path.join(DL, 'THE_SMILE_INFECTION.mp4'),
    os.path.join(DL, 'STREETLIGHT.mp4'),
    os.path.join(DL, 'CONCERNING_YOUR_DOG.mp4'),
    os.path.join(DL, 'ENTRY_13.mp4'),
    os.path.join(DL, 'ENTRY_53.mp4'),
    os.path.join(DL, 'ENTRY_77.mp4'),
    os.path.join(DL, 'FLOOR_13.mp4'),
    os.path.join(DL, 'PERSONHOOD_SCREENING.mp4'),
    os.path.join(DL, 'TAPE_5_THE_STAIRS.mp4'),
    os.path.join(DL, 'FALSE_REPORT.mp4'),
    os.path.join(DL, 'CURFEW.mp4'),
    os.path.join(HOME, 'analog-horror', 'readyornot', 'out', 'READY_OR_NOT.mp4'),
    os.path.join(HOME, 'backrooms-video', 'CLARK_ENCOUNTER_v2.mp4'),   # the Blender found-footage one
]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'tv')
os.makedirs(OUT, exist_ok=True)


def slug(path):
    return re.sub(r'[^A-Za-z0-9]+', '_', os.path.splitext(os.path.basename(path))[0]).strip('_').lower()


def duration(path):
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True)
        return float(r.stdout.strip() or 0)
    except Exception:
        return 0


srcs = sys.argv[1:] or SOURCES
index_path = os.path.join(OUT, 'index.json')
index = json.load(open(index_path)) if os.path.exists(index_path) and sys.argv[1:] else []
for src in srcs:
    if not os.path.exists(src):
        print('  skip (missing)', src); continue
    name = slug(src); dst = os.path.join(OUT, name + '.mp4')
    if not (os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)):
        print('  transcode', os.path.basename(src), '->', name + '.mp4')
        cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', 'scale=480:-2,fps=24', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
               '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', dst]
        r = subprocess.run(cmd)
        if r.returncode != 0:
            print('  !! ffmpeg failed for', src); continue
    title = os.path.splitext(os.path.basename(src))[0].replace('_', ' ')
    index = [e for e in index if e['file'] != name + '.mp4']
    index.append({'file': name + '.mp4', 'title': title, 'seconds': round(duration(dst))})
json.dump(index, open(index_path, 'w', encoding='utf-8'), indent=1)
print('playlist:', len(index), 'videos ->', index_path)
