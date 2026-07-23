# Hosted Classroom Deployment

This project can now run in two shapes:

- Local desktop mode: Electron opens the app on your computer and saves files locally.
- Hosted web mode: a Node server runs `yt-dlp`, creates background download jobs, and serves temporary result files to browser users.

Codex Sites can host compatible frontends, but this downloader needs a Node/Python backend because it runs `yt-dlp`. The simplest online deployment is Docker on a service such as Render, Railway, Fly.io, Azure Container Apps, or a VPS. The desktop app includes bundled `yt-dlp` and `ffmpeg` fallbacks so recipients do not need to install Python, codecs, yt-dlp, or ffmpeg separately. The Docker image also installs system `ffmpeg`.

## Portable Windows App

Build a single portable Windows executable:

```powershell
npm run build:portable
```

Send the generated `.exe` from the `dist` folder. Do not send only the desktop shortcut; the shortcut points back to this local project folder.

## Mac Desktop App

Mac builds must be created on macOS because Electron Builder does not produce macOS app bundles from Windows or Linux, and the bundled media helper binaries must be the macOS versions.

Build an Apple Silicon package on a Mac:

```bash
npm ci
npm run build:mac -- --arch=arm64
```

Build an Intel Mac package on an Intel macOS runner:

```bash
npm ci
npm run build:mac -- --arch=x64
```

The generated `.zip` files are written to `dist-mac`. The app is unsigned, so macOS Gatekeeper may require users to right-click the app, choose Open, and confirm the first launch. The GitHub Actions workflow `.github/workflows/build-mac.yml` builds both Mac variants on native GitHub-hosted macOS runners and uploads them to the release tag matching the version in `package.json`.

## Docker Quick Start

Build and run locally:

```powershell
docker build -t classroom-video-downloader .
docker run --rm -p 3000:3000 `
  -e CLASSROOM_ACCESS_CODE="class-demo-code" `
  classroom-video-downloader
```

Open `http://localhost:3000`. The app will ask for the class code before previewing or downloading.

## Required Environment

Set these on the hosting service:

```text
HOSTED_MODE=1
PORT=3000
PYTHON_BIN=python3
FFMPEG_LOCATION=
CLASSROOM_ACCESS_CODE=<choose-a-code-for-your-class>
DOWNLOADS_DIR=/tmp/classroom-video-downloads
DOWNLOAD_JOB_TTL_MS=3600000
DOWNLOAD_CLEANUP_INTERVAL_MS=300000
DOWNLOAD_MAX_CONCURRENT_JOBS=1
DOWNLOAD_TIMEOUT_MS=900000
```

`CLASSROOM_ACCESS_CODE` is intentionally simple for classroom use. Put stronger authentication in front of the app if the link will be widely shared. Leave `FFMPEG_LOCATION` blank when `ffmpeg` is on `PATH`; set it only if your host installs `ffmpeg` in a custom directory or executable path.

## Same-Origin Hosting

For Render, Railway, Fly.io, Azure Container Apps, or a VPS, deploy the Docker image as one web service. The frontend and backend share the same origin, so `public/config.js` can stay as:

```js
window.CLASSROOM_VIDEO_API_BASE_URL = "";
```

## Split Frontend And Backend

If you later host the static frontend somewhere else, such as a Sites-style static host, keep the backend on a Node/Python host and set:

```js
window.CLASSROOM_VIDEO_API_BASE_URL = "https://your-backend.example.com";
```

Also set this on the backend:

```text
PUBLIC_APP_ORIGIN=https://your-frontend.example.com
```

That lets browsers call the backend API with the class-code header.

## Operational Notes

- Hosted downloads are job-based. `POST /api/download` returns a job id, then the browser polls `/api/downloads/:jobId`.
- Completed hosted files are served through `/api/downloads/:jobId/file`.
- Old hosted files are deleted after `DOWNLOAD_JOB_TTL_MS`.
- `DOWNLOAD_MAX_CONCURRENT_JOBS=1` keeps classroom demos predictable and avoids overloading small hosts.
- The desktop app still works without `HOSTED_MODE=1`.
