"""Local development bridge; production deployments should use a WSGI server."""
import os
from wsgiref.simple_server import make_server
from parrot_app import application

if __name__ == '__main__':
    if not os.environ.get('PARROT_SERVICE_TOKEN', '').strip():
        raise SystemExit('Set PARROT_SERVICE_TOKEN before starting the bridge.')
    port = int(os.environ.get('PARROT_PORT', '3001'))
    with make_server('127.0.0.1', port, application) as server:
        print(f'Python bridge listening on loopback port {port}')
        server.serve_forever()
