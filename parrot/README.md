# Optional Python processing bridge

The bridge uses Python 3.12+ and its standard library. It is optional.
Start the main application first and complete its installation.

Generate your own token and place the same value in the main application's
local `.env` as `PARROT_SERVICE_TOKEN`. Set `PARROT_BASE_URL` to
`http://127.0.0.1:3001` for a bridge on the same computer. Never commit the token.

In a separate PowerShell terminal:

```powershell
$env:PARROT_SERVICE_TOKEN = Read-Host 'Bridge token'
python parrot/serve.py
```

In a separate Linux terminal:

```sh
read -r PARROT_SERVICE_TOKEN
export PARROT_SERVICE_TOKEN
python3 parrot/serve.py
```

The development server binds to loopback. For a server deployment, use a WSGI
server suitable for the operating system, import `parrot_app:application` from
the `parrot` directory, and protect the service with HTTPS and network controls.
The token must be supplied to the Python process separately; it does not load
the main application's `.env` automatically.

Endpoints: `GET /healthz`, authenticated `GET /v1/catalog`, source validation,
and authenticated `POST /v1/runs`. Built-in handlers normalize text, summarize
records, and provide an echo diagnostic. Custom managed source has no network
capabilities enabled by the Node bridge. The template is an offline starter
with no domain, query, or target. Python network helper allowlists are blank.
