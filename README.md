# LabCoat

Workspace-based desktop automation for enforcing focused, repeatable app environments. LabCoat lets you define workspaces with program rules, website blocking, and DNS category filtering, then applies those rules automatically when a workspace is active.

## Features
- Workspace rules: block, protect (auto-relaunch), auto-launch, and freeze selected processes.
- Program discovery: scan and add detected apps quickly.
- Process visibility: window thumbnails and running-window detection where supported.
- Network controls: hosts-file blocklist and DNS category blocking via NextDNS.
- Focus mode UI and per-workspace status summaries.

## Tech Stack
- Electron (main + renderer)
- Node.js 18+
- WebSocket (ws)
- Optional: NextDNS for DNS category blocking

## Getting Started

### Prerequisites
- Node.js 18+
- npm
- Administrator/root privileges if you want hosts-file or DNS changes

### Install
```bash
npm install
```

### Run
```bash
npm run dev
# or
npm start
```

## Usage
1. Create a workspace.
2. Add programs manually or use program discovery.
3. Assign rules.
Blocked: terminate if detected.
Protected: auto-launch and relaunch if stopped.
Auto-launch: start once on activation (no relaunch).
Frozen: throttle or suspend matching windows/processes.
4. Optionally add hosts-file blocks or DNS categories.
5. Activate the workspace to enforce rules.

## DNS Category Blocking (NextDNS)
LabCoat can manage DNS categories through NextDNS by running a local DNS proxy and updating system DNS while a workspace is active.
- Configure provider, API key, and profile ID in the DNS settings modal.
- Categories are fetched from NextDNS and can be toggled per workspace.

## Data & Configuration
LabCoat persists data in Electron's user data directory:
- `workspaces.json` for programs and workspace rules
- `dns-config.json` for DNS provider settings

## Project Structure
- `src/main.js` - Main process: IPC, enforcement, DNS/hosts logic
- `src/program-discovery-worker.js` - Background program discovery
- `public/index.html` - UI shell
- `public/renderer.js` - UI logic
- `public/styles.css` - UI styling

## Notes & Permissions
- Hosts-file updates require elevated privileges.
- DNS changes require elevated privileges and will update the system DNS while a workspace is active.
