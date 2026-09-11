import http.server, socketserver, os, sys, mimetypes, webbrowser, threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8220
ROOT = os.path.dirname(os.path.abspath(__file__))
mimetypes.add_type('model/gltf-binary', '.glb')
mimetypes.add_type('audio/ogg', '.ogg')
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('application/json', '.json')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        """byte ranges for the television's videos (SimpleHTTPRequestHandler ignores Range)"""
        rng = self.headers.get('Range')
        path = self.translate_path(self.path.split('?', 1)[0])
        if rng and rng.startswith('bytes=') and os.path.isfile(path):
            size = os.path.getsize(path)
            a, _, b = rng[6:].partition('-')
            try:
                start = int(a) if a else max(0, size - int(b))
                end = min(int(b), size - 1) if (a and b) else size - 1
            except ValueError:
                start, end = 0, size - 1
            if start > end or start >= size:
                self.send_response(416); self.send_header('Content-Range', 'bytes */%d' % size); self.end_headers(); return
            ctype = self.guess_type(path)
            self.send_response(206)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            self.send_header('Content-Length', str(end - start + 1))
            self.end_headers()
            with open(path, 'rb') as f:
                f.seek(start); left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 16, left))
                    if not chunk: break
                    try: self.wfile.write(chunk)
                    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError): return
                    left -= len(chunk)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if '404' in (args[1] if len(args) > 1 else ''):
            sys.stderr.write('404 %s\n' % args[0])


class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    if not os.path.exists(os.path.join(ROOT, 'assets', 'materials.json')):
        print('No extracted assets found. Run tools\\extract.bat first (needs your own Lethal Company install).')
    httpd = TS(('127.0.0.1', PORT), H)
    print(f'LETHAL WEB  ->  http://localhost:{PORT}')
    if '--no-browser' not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{PORT}')).start()
    httpd.serve_forever()
