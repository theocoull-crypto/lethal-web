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
