# Minstorage

## How to get minio enterprise for free
- go to the min.io website
- press "download"
- request a free license key

A simple, modern file browser for MinIO. One Go binary serves the React web app
and acts as a transparent S3 proxy to your MinIO server.

The browser never talks to MinIO directly. It speaks the S3 protocol to this Go
backend, which forwards every request to MinIO with the user's own signature
left intact (no re-signing). Because the browser only ever connects to the
backend's own origin, **MinIO needs no CORS configuration** and does not have to
be reachable from clients at all — only the backend needs to reach it.

## Screenshots

| Desktop | Tablet | Mobile |
| --- | --- | --- |
| ![Desktop](screenshots/images/desktop.png) | ![Tablet](screenshots/images/tablet.png) | ![Mobile](screenshots/images/mobile.png) |

> Regenerate these with the helper in [`screenshots/`](screenshots/) — see its
> usage at the top of [`screenshots/capture.mjs`](screenshots/capture.mjs).

## What you need

- Go 1.25 or newer
- Node.js 20 or newer
- A running MinIO server

## Setup, step by step

### 1. Build the web app

```bash
cd frontend
npm install
npm run build
```

This builds the web app and copies it into `backend/static`, so the Go server
can serve it.

### 2. Run the server

```bash
cd ../backend
go run main.go --minio http://127.0.0.1:9000

# full example
./backend --address 0.0.0.0:7002 --minio http://127.0.0.1:9000 --user minioadmin --pass minioadmin
```

`--minio` is the address the backend uses to reach MinIO. Its scheme controls
how the backend connects:

- `http://…`  → plain HTTP (default if no scheme is given)
- `https://…` → TLS

The backend then proxies the browser's S3 traffic to that address, so the
browser only ever connects back to the backend itself.

The server listens on `:8080` by default. To use a different address:

```bash
go run main.go --address 0.0.0.0:8080 --minio http://127.0.0.1:9000
go run main.go -a :9000 -m http://127.0.0.1:9001
```

> **MinIO CORS is not required.** Since the browser talks only to this backend,
> you do **not** need to configure `cors_allow_origin` on MinIO.

### 3. Log in

Open the server address in your browser (e.g. `http://localhost:8080`) and fill
in your MinIO credentials:

- **User**: your MinIO access key
- **Password**: your MinIO secret key (use the eye icon to reveal it)

Then click **Connect to MinIO**.

## What it can do

- Browse buckets and folders
- Upload files (button or drag and drop)
- Download files
- Delete files
- Image thumbnails and full-size previews
- Search the current view

## Command line options

| Flag                | Short | Description                                                  |
| ------------------- | ----- | ------------------------------------------------------------ |
| `--address`         | `-a`  | Address to listen on (default `:8080`)                       |
| `--minio`           | `-m`  | MinIO address the backend proxies to (scheme sets TLS)       |
| `--minio-tls`       |       | Force TLS to MinIO when `--minio` has no scheme (`=true`)    |
| `--user`            | `-u`  | MinIO access key for backend operations (e.g. previews)      |
| `--pass`            | `-p`  | MinIO secret key for backend operations                      |
| `--cert`            | `-c`  | Domain for automatic HTTPS (Let's Encrypt)                   |
| `--signupHostPort`  |       | Host:port used in generated signup links                     |

Whether the backend connects to MinIO over TLS is taken from the `--minio`
scheme (`https://` → on, `http://` → off). Only when no scheme is given does
`--minio-tls` apply — and it must be written as `--minio-tls=true` (the bare
`--minio-tls true` form is ignored by Go's flag parser).

You can also use environment variables: `ADDRESS`, `PORT`, `MINIO`, `MINIO_USER`,
`MINIO_PASS`, `MINIO_TLS`, and `PREVIEW_CACHE_DIR`.

## Automatic HTTPS (optional)

To serve over HTTPS with a free Let's Encrypt certificate:

```bash
go run main.go --cert example.com
```

Notes:

- The domain must point to this server (DNS A or AAAA record).
- The server needs to bind ports 80 and 443 (usually run as root or behind a
  reverse proxy). Port 80 is used for the certificate challenge.
- Certificates are cached in `previews/autocert/` and renew automatically.
- Open `https://example.com` (not http).

## Creating signup links (optional)

You can generate a one-time link that lets someone create a MinIO user.

```bash
go run main.go signup --signupHostPort 192.168.1.10:8080
```

This prints a link like `http://192.168.1.10:8080/signup/<token>`. The link is
valid for 24 hours and works only once.

## Project layout

```
.
├── frontend/   React web app (Vite + Tailwind)
├── backend/    Go server (serves the web app and previews)
└── README.md
```

## Tips

- Image previews are cached in `./previews` (change with `PREVIEW_CACHE_DIR`).
- Your MinIO login is kept only in the browser session and is gone on refresh.
- For frontend development, run `npm run dev` in `frontend/` against a running
  backend.
- If you get connection errors, check the `--minio` address (and its scheme) and
  that the backend can reach MinIO. The browser only needs to reach the backend.
