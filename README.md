# Better GitHub Utils

**English** | [日本語](./README-ja.md)  

Better GitHub Utils shows whether a GitHub user follows you (profile pages / following lists). It also provides an optional Personal Access Token (PAT) popup for authenticated API checks, rate-limit diagnostics, and repository automation helpers (archive/delete assistance).

## Features
- Show follow status on profile and followers/following lists
- Optionally store a Personal Access Token in the popup for authenticated API checks
- Rate-limit diagnostics (X-RateLimit headers) for troubleshooting
- Inline repository automation panel (Auto complete) for Archive/Delete tasks
- Resilient handling for MV3 service worker lifecycle with retries and content-side fallbacks

## Installation (developer)
1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the folder you extracted from the downloaded ZIP.

## Usage
- Open a GitHub profile or followers/following list to see follow status badges.
- Use the extension popup to set a Personal Access Token for better rate limits and to enable automation features.
