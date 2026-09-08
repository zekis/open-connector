# OfficeCLI Companion API

Open Connector can run [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) as a separate,
authenticated document service. The companion container owns the Office files and exposes a narrow
HTTP API; the `officecli` provider makes that API available to agents as normal Open Connector
Actions.

OfficeCLI supports `.docx`, `.xlsx`, and `.pptx` without requiring Microsoft Office. The companion
image installs a pinned upstream release and disables OfficeCLI's background update check so image
builds stay reproducible.

## Start The Companion

Create a strong API token in the repository `.env` file:

```dotenv
OFFICECLI_API_TOKEN=replace-with-at-least-24-random-characters
```

Start the published Open Connector image and build the companion locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.officecli.yml up -d --build
```

When developing provider changes from this checkout, include the Open Connector build overlay too:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.build.yml \
  -f docker-compose.officecli.yml \
  up -d --build
```

The overlay creates:

- `officecli-api` on the internal Compose network and host port `3030` by default.
- `officecli-documents`, a persistent volume mounted at `/documents` only in the companion.
- A health check and a two-command concurrency limit.
- The Open Connector private-network opt-in required to reach the companion by its Docker hostname.

Change the host port with `OFFICECLI_API_PORT`. Pin another upstream version at build time with
`OFFICECLI_VERSION`.

## Connect Open Connector

In the Open Connector console, open **OfficeCLI**, add a connection, and enter:

```text
API URL: http://officecli-api:3030
API Token: the OFFICECLI_API_TOKEN value from .env
```

The provider includes Actions to:

- List, upload, download, and delete documents.
- Create blank Word, Excel, and PowerPoint files.
- Duplicate an Excel worksheet while preserving its cells, formulas, layout, styles, hidden rows, and print settings.
  Worksheets containing images, charts, tables, or pivots are rejected instead of silently producing a lossy copy.
- Read a DOM path, query elements, or view text, outlines, statistics, issues, forms, HTML, and SVG.
- Apply atomic structured batch edits.
- Merge `{{key}}` templates into new documents.
- Validate documents and dump replayable batch JSON.
- Retrieve OfficeCLI element schema help before building an edit.

Uploads and downloads use Open Connector transit files, so an agent can move documents between
OfficeCLI and other connected providers without direct access to either container's filesystem.
Structured edits are flushed to disk before the Action returns, and downloads perform another save
barrier before streaming the file. This ensures a file exported to SharePoint or another connector
contains the latest OfficeCLI changes even when OfficeCLI is using a resident document process.

## HTTP API

The host publishes the API on `http://localhost:3030` unless the bind address or port is changed with
`OFFICECLI_API_BIND_ADDRESS` and `OFFICECLI_API_PORT`. It binds to loopback by default; the Open
Connector container reaches it over the internal Compose network. Every `/v1` request accepts
`Authorization: Bearer <token>` or `x-api-key: <token>`. `/health` is intentionally unauthenticated
for container health checks.

```bash
curl http://localhost:3030/v1/info \
  -H "authorization: Bearer $OFFICECLI_API_TOKEN"

curl http://localhost:3030/v1/documents \
  -H "authorization: Bearer $OFFICECLI_API_TOKEN"

curl http://localhost:3030/v1/commands \
  -H "authorization: Bearer $OFFICECLI_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"create","document":"reports/weekly.docx"}'
```

The API endpoints are:

| Method   | Path                   | Purpose                                             |
| -------- | ---------------------- | --------------------------------------------------- |
| `GET`    | `/health`              | Container health and OfficeCLI version              |
| `GET`    | `/v1/info`             | Authenticated server capabilities                   |
| `GET`    | `/v1/documents`        | Recursively list Office documents; accepts `prefix` |
| `PUT`    | `/v1/documents/{path}` | Upload a binary Office document                     |
| `GET`    | `/v1/documents/{path}` | Download an Office document                         |
| `DELETE` | `/v1/documents/{path}` | Delete an Office document                           |
| `POST`   | `/v1/commands`         | Run a structured, allow-listed OfficeCLI operation  |

`/v1/commands` accepts `create`, `duplicate_worksheet`, `get`, `query`, `view`, `batch`, `merge`, `validate`,
`dump`, and `help`.
It does not accept shell text or arbitrary command-line arguments.

## Security Boundary

- Document paths must stay beneath `/documents`; absolute paths, traversal, and symbolic links are
  rejected.
- Only `.docx`, `.xlsx`, and `.pptx` document targets are accepted.
- OfficeCLI is spawned directly with argument arrays, never through a shell.
- Batch operations and fields are allow-listed. Potential file-reference properties may only point
  inside the document volume, and external URLs are rejected.
- The container runs as an unprivileged user with a read-only root filesystem, dropped Linux
  capabilities, and `no-new-privileges`.
- The API token is removed from the OfficeCLI child process environment.

The Docker-network URL is private. The Compose overlay deliberately enables
`OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` on the connector so the SSRF-guarded provider fetch can reach
it. Cloudflare Workers cannot route to this companion; use the Node/Docker runtime.
