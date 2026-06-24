# Family Storage

A minimalistic modern file browser for MinIO.

- Single Go binary that embeds the React frontend
- Uses AWS SDK v3 for S3 (in-browser, MinIO compatible) for listing, upload, and downloads
- Authentication with MinIO access key / secret key (never embedded)
- Clean white + beige design
- Drag & drop uploads, downloads, basic folder navigation
- Image previews generated + cached by the Go backend


## Requirements

- Node.js 20+
- Go 1.22+
- MinIO is expected on the same host as the app, but on port = (app port - 2) by convention. (The UI auto-detects this.)

Default credentials used in examples: `minioadmin` / `minioadmin`

## Project Structure

```
.
├── frontend/          # Vite + React + Tailwind + minio SDK
├── backend/           # Go server (embeds frontend + preview API)
└── README.md
```

## Running (Recommended - Single Binary)

The Go backend now embeds the built React frontend and serves everything from a single port.

### 1. Build the frontend

```bash
cd frontend
npm install
npm run build
```

This produces static files in `frontend/dist`.

### 2. Run the Go server

```bash
cd ../backend
go run main.go
```

- The server listens on `:8080` by default.
- Use `--address` (or `-a`) to change it:
  ```bash
  go run main.go --address 0.0.0.0:8080
  go run main.go -a :9000
  ```
- You can also use the `ADDRESS` env var, or the legacy `PORT` env var.
- Image preview cache lives in `./previews` (override with `PREVIEW_CACHE_DIR`)

### Automatic HTTPS / Let's Encrypt

Use `--cert` (or `-c`) to enable automatic TLS certificates via Let's Encrypt:

```bash
go run main.go --cert=meow.com
# or
go run main.go -c example.com --address 0.0.0.0:443
```

- When `--cert=example.com` is provided:
  - The server automatically obtains (or loads from cache) a valid certificate for the domain.
  - Auto-renews the certificate before expiry (handled by Go's `autocert`).
  - ACME HTTP-01 challenges are served on port `:80` (required; must be publicly reachable for the domain).
  - The main SPA + API is served over HTTPS (on `:443` by default, or the port from `--address`).
  - Non-HTTPS requests are automatically redirected to HTTPS.
- Certs + keys are cached in the `previews/autocert/` directory (so they persist across restarts).
- **Requirements**: The binary must be able to bind to ports 80 and 443 (usually run as root, via systemd with caps, docker with host ports, or behind a reverse proxy that forwards the challenges).
- The domain must point (DNS A/AAAA) to the server.

- Open **https://yourdomain.com** (not http).

### 3. Login

- **MinIO Endpoint**: auto-filled (current host + current-port-2). You can edit it.
- Access Key / Secret Key
- **Preview Service**: leave **blank** (uses same origin)

Click **Connect to MinIO**.

The React app and the preview API are now served from the same origin, so no separate frontend port is needed.

## Important: CORS (for MinIO)

The React app uses the AWS SDK for S3 **directly from the browser** (MinIO is S3-compatible) to talk to your MinIO server for listing, uploading, and downloading.

You must configure CORS on MinIO for the origin where the app is served (e.g. `http://localhost:8080`).

### Using `mc` (recommended):

```bash
mc alias set local http://127.0.0.1:6998 minioadmin minioadmin   # example: if app on 7000, MinIO on 6998

# Allow the origin serving the app
mc admin config set local api cors_allow_origin 'http://localhost:8080'

mc admin service restart local
```

During development you can temporarily allow everything:

```bash
mc admin config set local api cors_allow_origin '*'
mc admin service restart local
```

## Features

- Browse buckets + navigate "folders" (prefixes)
- Upload (button + drag & drop)
- Download via presigned URLs
- Delete objects
- Real image thumbnails (via Go service + disk cache)
- Full-size image preview modal
- Search within current view
- Clean responsive grid

## Architecture Notes

- The Go binary embeds the React frontend (single deployable artifact)
- Credentials live only in React component state (gone on refresh)
- Preview generation + caching is handled server-side in Go
- The browser uses AWS SDK v3 (S3) to talk directly to MinIO for uploads, downloads, and object listing
- When "Preview Service" is left blank, the frontend calls `/preview` on the same origin

## Customization

- Preview width is currently hardcoded to 280px in thumbnails and 320px default on server
- Beige palette is defined in `frontend/tailwind.config.js`

## Development Tips

### Quick dev loop (embedded)

```bash
cd frontend && npm run build
cd ../backend && go run main.go
```

### Using separate frontend (advanced)

You can still run `npm run dev` in `frontend/` against a running Go backend.  
Just enter the full preview URL (e.g. `http://localhost:8080` or whatever address you used) in the login form.

### Other

- `go run` will fail with a clear message if `frontend/dist` is missing
- If you get connection issues: check the MinIO endpoint (host:port, no protocol) and MinIO CORS settings

Enjoy your files!
