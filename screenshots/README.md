# Screenshots

Captures desktop / tablet / mobile screenshots of the running MinStorage app and
writes them to `images/`, which the top-level `README.md` embeds.

## Usage

1. Start the backend (e.g. `./backend -a 0.0.0.0:7002 --minio http://127.0.0.1:7778 --user minioadmin --pass minioadmin`).
2. Install deps and run:

```bash
cd screenshots
npm install
MINSTORAGE_USER=<user> MINSTORAGE_PASS=<pass> npm run capture
```

3. Commit the regenerated PNGs in `images/`.

## Configuration (env vars)

| Var | Default | Description |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:7002` | URL of the running app |
| `MINSTORAGE_USER` | — | login user (MinIO access key) |
| `MINSTORAGE_PASS` | — | login pass (MinIO secret key) |
| `OUT_DIR` | `images` | output directory |
| `ENTER_FOLDER` | `screenshot stuff` | folder to open before capturing (set `""` for the bucket root) |
| `CHROME_PATH` | auto | path to a Chrome/Chromium binary; auto-detected from the puppeteer cache otherwise |

Uses `puppeteer-core` against an existing Chrome/Chromium binary (no large
browser download committed to the repo).
