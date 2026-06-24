# Family Storage

A simple, modern file browser for MinIO. One Go binary serves the React web app
and talks to your MinIO server.

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
go run main.go
```

The server now listens on `http://localhost:8080`.

To use a different address:

```bash
go run main.go --address 0.0.0.0:8080
go run main.go -a :9000
```

### 3. Allow the app in MinIO (CORS)

The web app talks to MinIO directly from the browser, so MinIO must allow the
address where the app runs.

```bash
mc alias set local http://127.0.0.1:9000 minioadmin minioadmin
mc admin config set local api cors_allow_origin 'http://localhost:8080'
mc admin service restart local
```

For local testing you can allow everything instead:

```bash
mc admin config set local api cors_allow_origin '*'
mc admin service restart local
```

### 4. Log in

Open `http://localhost:8080` in your browser and fill in:

- **MinIO Endpoint**: your MinIO address, for example `http://127.0.0.1:9000`
- **Access Key** and **Secret Key**: your MinIO credentials
- **Preview Service**: leave blank

Then click **Connect to MinIO**.

## What it can do

- Browse buckets and folders
- Upload files (button or drag and drop)
- Download files
- Delete files
- Image thumbnails and full-size previews
- Search the current view

## Command line options

| Flag                | Short | Description                                       |
| ------------------- | ----- | ------------------------------------------------- |
| `--address`         | `-a`  | Address to listen on (default `:8080`)            |
| `--minio`           | `-m`  | MinIO address the backend uses                    |
| `--user`            | `-u`  | MinIO access key for the backend                  |
| `--pass`            | `-p`  | MinIO secret key for the backend                  |
| `--cert`            | `-c`  | Domain for automatic HTTPS (Let's Encrypt)        |
| `--signupHostPort`  |       | Host:port used in generated signup links          |

You can also use environment variables: `ADDRESS`, `PORT`, `MINIO`, `MINIO_USER`,
`MINIO_PASS`, and `PREVIEW_CACHE_DIR`.

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
- Your MinIO login is kept only in the browser and is gone on refresh.
- For frontend development, run `npm run dev` in `frontend/` against a running
  backend.
- If you get connection errors, check the MinIO endpoint and MinIO CORS settings.
