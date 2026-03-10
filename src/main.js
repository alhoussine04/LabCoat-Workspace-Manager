const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { execSync, exec, execFile, fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const dns = require('dns');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DATA_FILE = path.join(app.getPath('userData'), 'workspaces.json');
const POLLING_INTERVAL = 3000; // 3 seconds for process detection
const IS_DEV = process.argv.includes('--dev');

// Some environments crash the GPU process; thumbnails still work without GPU.
app.disableHardwareAcceleration();

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let mainWindow = null;
let captureWindow = null;
let activeWorkspaceId = null;
let thumbnailInFlight = null;
let lastThumbnailResult = null;
let lastThumbnailAt = 0;
let enforcementState = {
  timers: {},      // Map of workspace IDs to timer IDs
  watchers: {},    // Map of programs to process states
  frozen: {},      // Map of process keys to frozen state
  frozenTimers: {}, // Map of workspace IDs to frozen polling timer
  hiddenCache: {}, // Map of process keys to last hidden window info
  blockedTimers: {}, // Map of workspace IDs to blocked polling timer
  protectedTimers: {}, // Map of workspace IDs to protected polling timer
  autoLaunchTimers: {}, // Map of workspace IDs to autoLaunch polling timer
};

// Program discovery state (kept in memory until app terminates)
let discoveryState = {
  status: 'idle', // idle | running | done | error
  results: [],
  seenExecPaths: new Set(),
  startedAt: null,
  finishedAt: null,
  error: null,
};
let discoveryWorker = null;

function _normalizeExecPath(execPath) {
  return (execPath || '').toLowerCase();
}

function _getDiscoveryResultsFiltered() {
  const data = DataStore.read();
  const existingPaths = new Set(
    data.programs.map((p) => _normalizeExecPath(p.execPath))
  );
  return discoveryState.results.filter(
    (p) => !existingPaths.has(_normalizeExecPath(p.execPath))
  );
}

function _startDiscoveryWorker() {
  if (discoveryState.status === 'running') {
    return;
  }

  discoveryState.status = 'running';
  discoveryState.startedAt = Date.now();
  discoveryState.finishedAt = null;
  discoveryState.error = null;

  const workerPath = path.join(__dirname, 'program-discovery-worker.js');
  discoveryWorker = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

  discoveryWorker.on('message', (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'found' && msg.program) {
      const execPathKey = _normalizeExecPath(msg.program.execPath);
      if (!execPathKey || discoveryState.seenExecPaths.has(execPathKey)) {
        return;
      }
      discoveryState.seenExecPaths.add(execPathKey);
      discoveryState.results.push(msg.program);

      const data = DataStore.read();
      const existingPaths = new Set(
        data.programs.map((p) => _normalizeExecPath(p.execPath))
      );

      if (!existingPaths.has(execPathKey)) {
        mainWindow?.webContents.send('program:discover:found', {
          program: msg.program,
          total: discoveryState.results.length,
          running: true,
        });
      }
      return;
    }

    if (msg.type === 'done') {
      discoveryState.status = 'done';
      discoveryState.finishedAt = Date.now();
      mainWindow?.webContents.send('program:discover:done', {
        total: discoveryState.results.length,
      });
      discoveryWorker?.kill();
      discoveryWorker = null;
      return;
    }

    if (msg.type === 'error') {
      discoveryState.status = 'error';
      discoveryState.error = msg.error || 'Discovery failed';
      discoveryState.finishedAt = Date.now();
      mainWindow?.webContents.send('program:discover:error', {
        error: discoveryState.error,
      });
      discoveryWorker?.kill();
      discoveryWorker = null;
    }
  });

  discoveryWorker.on('exit', (code) => {
    if (discoveryState.status === 'running') {
      discoveryState.status = code === 0 ? 'done' : 'error';
      discoveryState.finishedAt = Date.now();
      if (discoveryState.status === 'done') {
        mainWindow?.webContents.send('program:discover:done', {
          total: discoveryState.results.length,
        });
      } else {
        mainWindow?.webContents.send('program:discover:error', {
          error: discoveryState.error || 'Discovery process exited unexpectedly',
        });
      }
    }
    discoveryWorker = null;
  });

  discoveryWorker.send({ type: 'start' });
}

// ============================================================================
// PERSISTENCE LAYER
// ============================================================================

class DataStore {
  static initialize() {
    if (!fs.existsSync(DATA_FILE)) {
      const defaultData = {
        programs: [],
        workspaces: [],
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    }
  }

  static read() {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading data file:', err);
      return { programs: [], workspaces: [] };
    }
  }

  static write(data) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error('Error writing data file:', err);
      return false;
    }
  }
}

// ============================================================================
// HOSTS FILE BLOCKLIST ENFORCER
// ============================================================================

class HostsBlocklistEnforcer {
  static _hostsPath() {
    if (process.platform === 'win32') {
      return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    }
    return '/etc/hosts';
  }

  static _normalizeHost(input) {
    if (!input) return '';
    let value = input.trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^https?:\/\//, '');
    value = value.split('/')[0];
    value = value.replace(/:\d+$/, '');
    value = value.replace(/\s+/g, '');
    if (!value || value.includes(' ')) return '';
    if (!/^[a-z0-9.-]+$/.test(value)) return '';
    return value;
  }

  static _expandHosts(list) {
    const expanded = new Set();
    (Array.isArray(list) ? list : []).forEach((item) => {
      const host = this._normalizeHost(item);
      if (!host) return;
      expanded.add(host);
      if (!host.startsWith('www.')) {
        expanded.add(`www.${host}`);
      }
    });
    return Array.from(expanded);
  }

  static _markerStart(workspaceId) {
    return `# LabCoat Hosts START ${workspaceId}`;
  }

  static _markerEnd(workspaceId) {
    return `# LabCoat Hosts END ${workspaceId}`;
  }

  static _stripWorkspaceBlock(contents, workspaceId) {
    const start = this._markerStart(workspaceId);
    const end = this._markerEnd(workspaceId);
    const lines = contents.split(/\r?\n/);
    const output = [];
    let skipping = false;
    for (const line of lines) {
      if (line.trim() === start) {
        skipping = true;
        continue;
      }
      if (line.trim() === end) {
        skipping = false;
        continue;
      }
      if (!skipping) output.push(line);
    }
    return output.join(os.EOL).trimEnd() + os.EOL;
  }

  static _appendWorkspaceBlock(contents, workspaceId, hosts) {
    const start = this._markerStart(workspaceId);
    const end = this._markerEnd(workspaceId);
    const lines = [
      start,
      ...hosts.map((host) => `0.0.0.0 ${host}`),
      end,
    ];
    const trimmed = contents.trimEnd();
    return `${trimmed}${os.EOL}${lines.join(os.EOL)}${os.EOL}`;
  }

  static applyWorkspace(workspaceId, hosts) {
    const normalizedHosts = this._expandHosts(hosts);
    const hostsPath = this._hostsPath();
    const existing = fs.readFileSync(hostsPath, 'utf-8');
    let updated = this._stripWorkspaceBlock(existing, workspaceId);
    if (normalizedHosts.length > 0) {
      updated = this._appendWorkspaceBlock(updated, workspaceId, normalizedHosts);
    }
    fs.writeFileSync(hostsPath, updated, 'utf-8');
    return normalizedHosts.length;
  }

  static removeWorkspace(workspaceId) {
    const hostsPath = this._hostsPath();
    const existing = fs.readFileSync(hostsPath, 'utf-8');
    const updated = this._stripWorkspaceBlock(existing, workspaceId);
    if (updated !== existing) {
      fs.writeFileSync(hostsPath, updated, 'utf-8');
    }
  }
}

// ============================================================================
// PROCESS CONTROL LAYER (Cross-Platform)
// ============================================================================

class ProcessControl {
  static isProcessRunning(execPath) {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return this._isRunningWindows(execPath);
      } else if (platform === 'darwin') {
        return this._isRunningMacOS(execPath);
      } else if (platform === 'linux') {
        return this._isRunningLinux(execPath);
      }
    } catch (err) {
      console.error(`Error checking process status for ${execPath}:`, err);
      return false;
    }
  }

  static isProgramRunning(program) {
    if (!program) return false;
    if (this.isProcessRunning(program.execPath)) {
      return true;
    }

    if (process.platform === 'win32') {
      return this._isRunningWindowsByTitle(program.name);
    }

    return false;
  }

  static _isRunningWindowsByTitle(programName) {
    try {
      if (!programName) return false;
      const escaped = programName.replace(/'/g, "''");
      const output = execSync(
        `powershell -NoProfile -Command "$p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${escaped}*' }; if ($p) { '1' } else { '0' }"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      return output.trim() === '1';
    } catch (err) {
      return false;
    }
  }

  static _terminateWindowsByTitle(programName) {
    try {
      if (!programName) return false;
      const escaped = programName.replace(/'/g, "''");
      const output = execSync(
        `powershell -NoProfile -Command "$p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${escaped}*' }; if ($p) { $p | Stop-Process -Force; '1' } else { '0' }"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      return output.trim() === '1';
    } catch (err) {
      return false;
    }
  }

  static getWindowedProcesses() {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return this._getWindowedProcessesWindows();
      } else if (platform === 'darwin') {
        return this._getWindowedProcessesMacOS();
      } else if (platform === 'linux') {
        return this._getWindowedProcessesLinux();
      }
    } catch (err) {
      console.error('Error listing windowed processes:', err);
      return [];
    }
  }

  static _getWindowedProcessesWindows() {
    try {
      const helperPath = this._getWindowsSuspendHelperPath();
      if (helperPath && fs.existsSync(helperPath)) {
        try {
          const output = execSync(`"${helperPath}" windows`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
          return lines
            .map((line) => {
              const [pidRaw, name, title] = line.split('|||');
              const pid = Number(pidRaw);
              return {
                pid,
                name: name || '',
                title: title || '',
                path: '',
              };
            })
            .filter((proc) => proc.title.trim().length > 0 && !Number.isNaN(proc.pid));
        } catch (err) {
          // fall back to snapshot
        }
      }

      const snapshot = this._getWindowsProcessSnapshot();
      return snapshot
        .map((proc) => ({
          name: (proc?.Name || '').toString(),
          title: (proc?.MainWindowTitle || '').toString(),
          pid: proc?.Id,
          path: (proc?.Path || '').toString(),
        }))
        .filter((proc) => proc.title.trim().length > 0);
    } catch (err) {
      return [];
    }
  }

  static _getWindowedProcessesMacOS() {
    try {
      const script = [
        `tell application "System Events"`,
        `set output to ""`,
        `repeat with p in (processes whose visible is true and (count of windows) > 0)`,
        `set pid to unix id of p`,
        `set pname to name of p`,
        `repeat with w in windows of p`,
        `set wname to name of w`,
        `set output to output & pid & "|||" & pname & "|||" & wname & linefeed`,
        `end repeat`,
        `end repeat`,
        `return output`,
        `end tell`,
      ].join('\n');

      const output = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [pid, name, title] = line.split('|||');
          return { pid: Number(pid), name: name || '', title: title || '' };
        })
        .filter((proc) => proc.title.trim().length > 0);
    } catch (err) {
      return [];
    }
  }

  static _getWindowedProcessesLinux() {
    try {
      if (!this._hasCommand('wmctrl')) {
        return [];
      }

      const output = execSync('wmctrl -lp', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const results = [];

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const pid = Number(parts[2]);
        const title = parts.slice(4).join(' ').trim();
        if (!title) continue;
        const name = this._linuxGetProcessName(pid);
        results.push({ pid, name: name || '', title });
      }

      return results;
    } catch (err) {
      return [];
    }
  }

  static _linuxGetProcessName(pid) {
    try {
      const commPath = `/proc/${pid}/comm`;
      if (fs.existsSync(commPath)) {
        return fs.readFileSync(commPath, 'utf-8').trim();
      }
    } catch (err) {
      // ignore
    }
    return '';
  }

  static _linuxGetWindowIdsByPid(pid) {
    if (!pid || !this._hasCommand('wmctrl')) return [];
    try {
      const output = execSync('wmctrl -lp', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const ids = [];
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;
        const winId = parts[0];
        const linePid = Number(parts[2]);
        if (linePid === Number(pid)) {
          ids.push(winId);
        }
      }
      return ids;
    } catch (err) {
      return [];
    }
  }

  static _showWindowByTitleWindows(title, name) {
    try {
      const helperPath = this._getWindowsSuspendHelperPath();
      if (!helperPath || !fs.existsSync(helperPath)) return false;
      const safeTitle = (title || '').trim();
      if (!safeTitle) return false;
      const safeName = (name || '').trim().replace(/"/g, '""');
      if (safeName) {
        execSync(`"${helperPath}" showtitleproc "${safeName}" "${safeTitle.replace(/"/g, '""')}"`, {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } else {
        execSync(`"${helperPath}" showtitle "${safeTitle.replace(/"/g, '""')}"`, {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  static _showWindowByTitleLinux(title) {
    try {
      if (!this._hasCommand('wmctrl')) return false;
      const needle = (title || '').trim();
      if (!needle) return false;
      const output = execSync('wmctrl -lp', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const ids = [];
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const winId = parts[0];
        const winTitle = parts.slice(4).join(' ');
        if (winTitle.toLowerCase().includes(needle.toLowerCase())) {
          ids.push(winId);
        }
      }
      if (ids.length === 0) return false;
      ids.forEach((id) => {
        execSync(`wmctrl -i -r ${id} -b remove,hidden`, { stdio: ['pipe', 'pipe', 'ignore'] });
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  static _getWindowsProcessSnapshot() {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "Get-Process | Select-Object Name, Id, MainWindowTitle, Path | ConvertTo-Json -Depth 2"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (!output) return [];
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed;
      if (parsed) return [parsed];
      return [];
    } catch (err) {
      return [];
    }
  }

  static _matchProgramsAgainstWindowsSnapshot(programs, snapshot) {
    const runningIds = new Set();
    const windowedIds = new Set();

    const normalized = snapshot.map((proc) => ({
      name: (proc?.Name || '').toString(),
      nameLower: (proc?.Name || '').toString().toLowerCase(),
      title: (proc?.MainWindowTitle || '').toString(),
      titleLower: (proc?.MainWindowTitle || '').toString().toLowerCase(),
      pathLower: (proc?.Path || '').toString().toLowerCase(),
    }));

    programs.forEach((program) => {
      const execPath = program.execPath || '';
      const execLower = execPath.toLowerCase();
      const programName = (program.name || '').toLowerCase();

      const candidates = new Set();
      if (execLower.endsWith('.exe')) {
        candidates.add(path.basename(execLower).replace(/\.exe$/i, ''));
      }

      if (execLower.startsWith('shell:appsfolder\\')) {
        const tail = execLower.split('\\').pop() || '';
        const appId = tail.split('!')[0] || '';
        const base = appId.split('_')[0] || '';
        if (base) {
          candidates.add(base);
          if (base.endsWith('desktop')) {
            candidates.add(base.slice(0, -'desktop'.length));
          }
        }
      }

      if (programName) {
        candidates.add(programName);
      }

      const matches = normalized.filter((proc) => {
        const nameMatch = Array.from(candidates).some((cand) => cand && proc.nameLower === cand);
        const pathMatch = execLower.endsWith('.exe') && proc.pathLower.endsWith(path.basename(execLower));
        const titleMatch = programName && proc.titleLower.includes(programName);
        return nameMatch || pathMatch || titleMatch;
      });

      if (matches.length > 0) {
        runningIds.add(program.id);
        if (matches.some((proc) => proc.title && proc.title.trim().length > 0)) {
          windowedIds.add(program.id);
        }
      }
    });

    return { runningIds, windowedIds };
  }

  static hasVisibleWindow(execPath) {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return this._hasWindowWindows(execPath);
      } else if (platform === 'darwin') {
        return this._hasWindowMacOS(execPath);
      } else if (platform === 'linux') {
        return this._hasWindowLinux(execPath);
      }
    } catch (err) {
      console.error(`Error checking window status for ${execPath}:`, err);
      return false;
    }
  }

  static _hasCommand(command) {
    try {
      execSync(`which "${command}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
      return true;
    } catch (err) {
      return false;
    }
  }

  static isChromiumProcessName(name) {
    const lower = (name || '').toLowerCase();
    if (!lower) return false;
    return [
      'chrome',
      'chromium',
      'msedge',
      'msedgewebview2',
      'brave',
      'vivaldi',
      'opera',
      'electron',
    ].some((token) => lower.includes(token));
  }

  static async _cdpFetchJson(port) {
    return new Promise((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/json/list', timeout: 1000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(Array.isArray(parsed) ? parsed : []);
            } catch (err) {
              resolve([]);
            }
          });
        }
      );
      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });
    });
  }

  static _findTargetByTitle(targets, windowTitle) {
    const title = (windowTitle || '').toLowerCase();
    if (!title) return null;
    const pages = targets.filter((t) => t && (t.type === 'page' || t.type === 'app'));
    return (
      pages.find((t) => (t.title || '').toLowerCase() === title) ||
      pages.find((t) => (t.title || '').toLowerCase().includes(title)) ||
      pages.find((t) => title.includes((t.title || '').toLowerCase()))
    );
  }

  static _wsSendCommand(ws, id, method, params) {
    return new Promise((resolve) => {
      const payload = { id, method, params };
      ws.send(JSON.stringify(payload), () => {});
      const timer = setTimeout(() => resolve({ ok: false }), 1000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id && !msg.error) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false });
          }
        } catch {
          resolve({ ok: false });
        }
      });
    });
  }

  static async cdpSetLifecycleStateByTitle(windowTitle, state) {
    const ports = [9222, 9223, 9229, 9333];
    for (const port of ports) {
      const targets = await this._cdpFetchJson(port);
      if (!targets || targets.length === 0) continue;
      const target = this._findTargetByTitle(targets, windowTitle);
      if (!target || !target.webSocketDebuggerUrl) continue;

      try {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        const openOk = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 1000);
          ws.once('open', () => {
            clearTimeout(timer);
            resolve(true);
          });
          ws.once('error', () => {
            clearTimeout(timer);
            resolve(false);
          });
        });

        if (!openOk) {
          ws.close();
          continue;
        }

        const enableOk = await this._wsSendCommand(ws, 1, 'Page.enable', {});
        if (!enableOk.ok) {
          ws.close();
          continue;
        }

        const stateOk = await this._wsSendCommand(ws, 2, 'Page.setWebLifecycleState', {
          state,
        });
        ws.close();
        if (stateOk.ok) return true;
      } catch (err) {
        continue;
      }
    }

    return false;
  }

  static throttleProcessByPid(pid) {
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        const helperPath = this._getWindowsSuspendHelperPath();
        if (helperPath && fs.existsSync(helperPath)) {
          execSync(`"${helperPath}" throttle ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] });
          return true;
        }
        return false;
      }

      execSync(`renice 10 -p ${pid}`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static hideWindowForProcess(proc) {
    if (!proc || !(proc.title || '').trim()) return false;
    try {
      if (process.platform === 'win32') {
        const helperPath = this._getWindowsSuspendHelperPath();
        if (helperPath && fs.existsSync(helperPath)) {
          const safeTitle = proc.title.replace(/"/g, '""');
          const safeName = (proc.name || '').replace(/"/g, '""').trim();
          if (safeName) {
            execSync(`"${helperPath}" hidetitleproc "${safeName}" "${safeTitle}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
          } else {
            execSync(`"${helperPath}" hidetitle "${safeTitle}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
          }
          return true;
        }
        return false;
      }

      if (process.platform === 'darwin') {
        const title = (proc.title || '').trim();
        if (!title) return false;
        const script = [
          'tell application "System Events"',
          'repeat with p in (processes whose visible is true)',
          'repeat with w in windows of p',
          `if (name of w) contains "${title.replace(/"/g, '\\"')}" then`,
          'set visible of p to false',
          'end if',
          'end repeat',
          'end repeat',
          'end tell',
        ].join('\n');
        execSync(`osascript -e "${script}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
        return true;
      }

      if (process.platform === 'linux') {
        const title = (proc.title || '').trim();
        if (!title || !this._hasCommand('wmctrl')) return false;
        const output = execSync('wmctrl -lp', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
        const needle = title.toLowerCase();
        const ids = [];
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length < 5) continue;
          const winId = parts[0];
          const winTitle = parts.slice(4).join(' ');
          if (winTitle.toLowerCase().includes(needle)) {
            ids.push(winId);
          }
        }
        if (ids.length === 0) return false;
        ids.forEach((id) => {
          execSync(`wmctrl -i -r ${id} -b add,hidden`, { stdio: ['pipe', 'pipe', 'ignore'] });
        });
        return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  static showWindowForProcess(proc) {
    if (!proc || !(proc.title || '').trim()) return false;
    try {
      if (process.platform === 'win32') {
        const helperPath = this._getWindowsSuspendHelperPath();
        if (helperPath && fs.existsSync(helperPath)) {
          if (proc.pid) {
            try {
              execSync(`"${helperPath}" show ${proc.pid}`, { stdio: ['pipe', 'pipe', 'ignore'] });
              return true;
            } catch (err) {
              // fall through to title match
            }
          }
          return this._showWindowByTitleWindows(proc.title, proc.name);
        }
        return this._showWindowByTitleWindows(proc.title, proc.name);
      }

      if (process.platform === 'darwin') {
        const name = (proc.name || '').trim();
        if (!name) return false;
        const script = `tell application "System Events" to set visible of process "${name.replace(/"/g, '\\"')}" to true`;
        execSync(`osascript -e "${script}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
        return true;
      }

      if (process.platform === 'linux') {
        const ids = proc.pid ? this._linuxGetWindowIdsByPid(proc.pid) : [];
        if (ids.length === 0) {
          return this._showWindowByTitleLinux(proc.title);
        }
        ids.forEach((id) => {
          execSync(`wmctrl -i -r ${id} -b remove,hidden`, { stdio: ['pipe', 'pipe', 'ignore'] });
        });
        return true;
      }
    } catch (err) {
      if (process.platform === 'win32') {
        return this._showWindowByTitleWindows(proc.title, proc.name);
      }
      if (process.platform === 'linux') {
        return this._showWindowByTitleLinux(proc.title);
      }
      return false;
    }
    return false;
  }

  static restorePriorityByPid(pid) {
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        const helperPath = this._getWindowsSuspendHelperPath();
        if (helperPath && fs.existsSync(helperPath)) {
          execSync(`"${helperPath}" restore ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] });
          return true;
        }
        return false;
      }

      execSync(`renice 0 -p ${pid}`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static isPidRunning(pid) {
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        const output = execSync(
          `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '1' } else { '0' }"`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
        );
        return output.trim() === '1';
      }
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return false;
    }
  }


  static _getWindowsSuspendHelperPath() {
    try {
      const repoHelper = path.join(__dirname, '..', 'tools', 'LabCoatSuspendHelper.exe');
      if (fs.existsSync(repoHelper)) {
        return repoHelper;
      }
      const baseDir = path.join(app.getPath('userData'), 'helpers');
      return path.join(baseDir, 'LabCoatSuspendHelper.exe');
    } catch (err) {
      return null;
    }
  }

  static _ensureWindowsSuspendHelper() {
    try {
      const helperPath = this._getWindowsSuspendHelperPath();
      if (!helperPath) return false;
      if (fs.existsSync(helperPath)) return true;

      const baseDir = path.dirname(helperPath);
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }

      const source = [
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class NtProcess {',
        '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
        '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);',
        '  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);',
        '  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);',
        '  public static int Suspend(int pid){',
        '    IntPtr h=OpenProcess(0x1F0FFF,false,pid);',
        '    if(h==IntPtr.Zero) return Marshal.GetLastWin32Error();',
        '    int status=NtSuspendProcess(h);',
        '    CloseHandle(h);',
        '    return status;',
        '  }',
        '  public static int Resume(int pid){',
        '    IntPtr h=OpenProcess(0x1F0FFF,false,pid);',
        '    if(h==IntPtr.Zero) return Marshal.GetLastWin32Error();',
        '    int status=NtResumeProcess(h);',
        '    CloseHandle(h);',
        '    return status;',
        '  }',
        '}',
        'public class Program {',
        '  public static int Main(string[] args) {',
        '    if(args.Length < 2) return 2;',
        '    string cmd = args[0].ToLowerInvariant();',
        '    if(!int.TryParse(args[1], out int pid)) return 3;',
        '    int res = cmd == "resume" ? NtProcess.Resume(pid) : NtProcess.Suspend(pid);',
        '    return res == 0 ? 0 : res;',
        '  }',
        '}',
      ].join('\n');

      const sourcePath = path.join(baseDir, 'LabCoatSuspendHelper.cs');
      fs.writeFileSync(sourcePath, source, 'utf-8');

      try {
        execSync('where csc', { stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (err) {
        console.warn('[ProcessControl] csc not found. Install .NET SDK or place Sysinternals pssuspend in PATH.');
        return false;
      }

      execSync(`csc /nologo /target:exe /out:"${helperPath}" "${sourcePath}"`, {
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      return fs.existsSync(helperPath);
    } catch (err) {
      console.warn(`[ProcessControl] Failed to create suspend helper: ${err.message || err}`);
      return false;
    }
  }

  static _hasWindowWindows(execPath) {
    try {
      const processNames = this._getWindowsProcessNames(execPath);
      if (processNames.length === 0) return false;

      for (const rawName of processNames) {
        const name = rawName.replace(/\.exe$/i, '');
        try {
          const output = execSync(
            `powershell -NoProfile -Command "$p=Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' }; if ($p) { '1' } else { '0' }"`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
          );
          if (output.trim() === '1') {
            return true;
          }
        } catch (err) {
          continue;
        }
      }

      return false;
    } catch (err) {
      return false;
    }
  }

  static _hasWindowMacOS(execPath) {
    try {
      const processName = path.basename(execPath);
      if (!processName) return false;

      const script = [
        `tell application "System Events"`,
        `set procs to (processes whose name is "${processName}" and (count of windows) > 0 and visible is true)`,
        `if (count of procs) > 0 then`,
        `return "1"`,
        `else`,
        `return "0"`,
        `end if`,
        `end tell`,
      ].join('\n');

      const output = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      return output.trim() === '1';
    } catch (err) {
      return false;
    }
  }

  static _hasWindowLinux(execPath) {
    try {
      if (!this._hasCommand('wmctrl')) {
        return false;
      }

      const processName = path.basename(execPath);
      if (!processName) return false;

      const output = execSync('wmctrl -lp', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const pid = parts[2];
        const title = parts.slice(4).join(' ').trim();
        if (!title) continue;
        if (this._linuxPidMatchesProcessName(pid, processName)) {
          return true;
        }
      }

      return false;
    } catch (err) {
      return false;
    }
  }

  static _linuxPidMatchesProcessName(pid, processName) {
    try {
      const commPath = `/proc/${pid}/comm`;
      if (fs.existsSync(commPath)) {
        const comm = fs.readFileSync(commPath, 'utf-8').trim();
        if (comm && comm === processName) {
          return true;
        }
      }
    } catch (err) {
      // ignore
    }

    try {
      const exePath = fs.readlinkSync(`/proc/${pid}/exe`);
      if (exePath && path.basename(exePath) === processName) {
        return true;
      }
    } catch (err) {
      // ignore
    }

    return false;
  }

  static isSystemCritical(execPath) {
    if (!execPath) return false;
    const platform = process.platform;
    const names = platform === 'win32'
      ? this._getWindowsProcessNames(execPath)
      : [path.basename(execPath)];

    if (names.some((name) => this._isCriticalName(name))) {
      return true;
    }

    return this._isCriticalPath(execPath);
  }

  static _isCriticalName(name) {
    if (!name) return false;
    const criticalKeywords = [
      'kernel','security','defender','antimalware','firewall','credential','certificate',
      'cryptographic','telemetry','driver','update','service','agent','host process','system','windows',
    ];
    const lowerName = name.toLowerCase();
    return criticalKeywords.some((keyword) => lowerName.includes(keyword));
  }

  static _isCriticalPath(execPath) {
    if (!execPath) return false;
    const lowerPath = execPath.toLowerCase();
    const criticalPaths = [
      'c:\\windows\\system32','c:\\windows\\syswow64','c:\\windows\\winsxs','c:\\windows\\servicing',
      'c:\\windows\\systemapps','c:\\windows\\assembly','c:\\windows\\tasks','c:\\windows\\fonts',
      'c:\\windows\\inf','c:\\windows\\security',
      process.env.WINDIR?.toLowerCase() + '\\system32',
      process.env.WINDIR?.toLowerCase() + '\\winsxs',
      process.env.WINDIR?.toLowerCase() + '\\systemapps',
      process.env.SYSTEMROOT?.toLowerCase() + '\\system32',
      process.env.SYSTEMROOT?.toLowerCase() + '\\winsxs',
      process.env.SYSTEMROOT?.toLowerCase() + '\\systemapps',
      '/System/Library','/System/Applications','/usr/sbin','/sbin','/bin','/usr/bin','/usr/lib','/lib','/lib64','/snap',
    ];
    return criticalPaths.some((criticalPath) => criticalPath && lowerPath.startsWith(criticalPath.toLowerCase()));
  }

  static _getWindowsProcessNames(execPath) {
    const names = new Set();
    if (!execPath) return [];

    const lowerPath = execPath.toLowerCase();
    if (lowerPath.startsWith('shell:appsfolder\\')) {
      const exeMatch = execPath.match(/([^\\\/]+\.exe)$/i);
      if (exeMatch && exeMatch[1]) {
        names.add(exeMatch[1]);
      }

      const tail = execPath.split('\\').pop() || '';
      const appId = tail.split('!')[0] || '';
      const base = appId.split('_')[0] || '';
      if (base) {
        names.add(base);
        if (base.toLowerCase().endsWith('desktop')) {
          names.add(base.slice(0, -'desktop'.length));
        }
      }
    } else {
      const baseName = path.basename(execPath);
      if (baseName) {
        names.add(baseName);
      }
    }

    return Array.from(names).filter(Boolean);
  }

  static _isRunningWindows(execPath) {
    try {
      if (!execPath) return false;
      const lowerPath = execPath.toLowerCase();
      const isShellApp = lowerPath.startsWith('shell:appsfolder\\');

      const exeMatch = execPath.match(/([^\\\/]+\.exe)$/i);
      if (exeMatch && exeMatch[1]) {
        const processName = exeMatch[1];
        const output = execSync(`tasklist /FI "IMAGENAME eq ${processName}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        return output.toLowerCase().includes(processName.toLowerCase());
      }

      if (isShellApp) {
        // Try to infer process name from AppsFolder AppID (e.g., WhatsAppDesktop)
        const tail = execPath.split('\\').pop() || '';
        const appId = tail.split('!')[0] || '';
        const base = appId.split('_')[0] || '';
        if (!base) return false;

        const candidates = [base];
        if (base.toLowerCase().endsWith('desktop')) {
          candidates.push(base.slice(0, -'desktop'.length));
        }

        for (const name of candidates) {
          const imageName = `${name}.exe`;
          const output = execSync(`tasklist /FI "IMAGENAME eq ${imageName}"`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          if (output.toLowerCase().includes(imageName.toLowerCase())) {
            return true;
          }
        }
      }

      return false;
    } catch (err) {
      return false;
    }
  }

  static _isRunningMacOS(execPath) {
    try {
      const processName = path.basename(execPath);
      execSync(`pgrep -x "${processName}"`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static _isRunningLinux(execPath) {
    try {
      const processName = path.basename(execPath);
      execSync(`pgrep -x "${processName}"`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static terminateProcess(execPath) {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return this._terminateWindows(execPath);
      } else if (platform === 'darwin') {
        return this._terminateMacOS(execPath);
      } else if (platform === 'linux') {
        return this._terminateLinux(execPath);
      }
    } catch (err) {
      console.error(`Error terminating process ${execPath}:`, err);
      return false;
    }
  }

  static unfreezeProcessByPid(pid) {
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        if (this._hasCommand('pssuspend')) {
          try {
            execSync(`pssuspend -nobanner -r ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] });
            return true;
          } catch (err) {
            // fall through
          }
        }
        if (this._ensureWindowsSuspendHelper()) {
          const helperPath = this._getWindowsSuspendHelperPath();
          try {
            execSync(`"${helperPath}" resume ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] });
            return true;
          } catch (err) {
            console.warn(`[ProcessControl] Resume helper failed for PID ${pid}: ${err.message || err}`);
            return false;
          }
        }

        console.warn('[ProcessControl] Windows resume helper unavailable. Install .NET SDK or Sysinternals pssuspend.');
        return false;
      }

      execSync(`kill -CONT ${pid}`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      console.warn(`[ProcessControl] Unfreeze by PID failed (${pid}): ${err.message || err}`);
      return false;
    }
  }

  static _terminateWindows(execPath) {
    try {
      if (!execPath) {
        return false;
      }
      if (this.isSystemCritical(execPath)) {
        return false;
      }

      const names = this._getWindowsProcessNames(execPath);
      const candidates = names.length > 0
        ? names
        : [path.basename(execPath)].filter(Boolean);

      let terminated = false;
      candidates.forEach((name) => {
        const imageName = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
        try {
          execSync(`taskkill /F /IM "${imageName}" /T`, { stdio: ['pipe', 'pipe', 'ignore'] });
          terminated = true;
        } catch (err) {
          // keep trying other candidates
        }
      });

      return terminated;
    } catch (err) {
      return false;
    }
  }

  static _terminateMacOS(execPath) {
    try {
      const processName = path.basename(execPath);
      execSync(`killall -9 "${processName}"`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static _terminateLinux(execPath) {
    try {
      const processName = path.basename(execPath);
      execSync(`pkill -9 "${processName}"`, { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }

  static launchProcess(execPath, args = []) {
    try {
      console.log(`[ProcessControl] Attempting to launch: ${execPath}`);

      const platform = process.platform;
      let resolvedPath = execPath;

      if (platform === 'darwin' || platform === 'linux') {
        if (!execPath.includes('/') && !execPath.includes('\\')) {
          const resolved = this._resolveUnixProgram(execPath);
          if (resolved) {
            resolvedPath = resolved;
            console.log(`[ProcessControl] Resolved program name to path: ${resolvedPath}`);
          }
        }
      }

      if (platform === 'win32') {
        const isShellApp = resolvedPath.toLowerCase().startsWith('shell:appsfolder\\');
        if (!isShellApp) {
          console.error(`[ProcessControl] Windows launch blocked for non-AppsFolder path: ${resolvedPath}`);
          return false;
        }

        exec(`start "" "${resolvedPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
          detached: true,
          windowsHide: false,
        }, (error) => {
          if (error) {
            console.error(`[ProcessControl] Launch error: ${error.message}`);
          }
        });

        console.log(`[ProcessControl] Windows process launched successfully for: ${resolvedPath}`);
        return true;
      }

      if (resolvedPath.includes('/') || resolvedPath.includes('\\')) {
        if (!fs.existsSync(resolvedPath)) {
          console.error(`[ProcessControl] File not found: ${resolvedPath}`);
          return false;
        }

        execFile(resolvedPath, args, {
          detached: true,
          stdio: 'ignore',
        }, (error) => {
          if (error) {
            console.error(`[ProcessControl] Launch error: ${error.message}`);
          }
        });

        console.log(`[ProcessControl] Unix process launched successfully for: ${resolvedPath}`);
        return true;
      }

      exec(resolvedPath, {
        detached: true,
        stdio: 'ignore',
      }, (error) => {
        if (error) {
          console.error(`[ProcessControl] Launch error: ${error.message}`);
        }
      });

      console.log(`[ProcessControl] Unix command launched successfully: ${resolvedPath}`);
      return true;
    } catch (err) {
      console.error(`[ProcessControl] Error launching process ${execPath}:`, err.message);
      return false;
    }
  }

  static _resolveUnixProgram(programName) {
    try {
      const result = execSync(`which "${programName}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return result.trim();
    } catch (err) {
      const commonPaths = [
        '/usr/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/local/sbin',
        '/opt/bin'
      ];

      for (const basePath of commonPaths) {
        if (!fs.existsSync(basePath)) continue;

        try {
          const items = fs.readdirSync(basePath);
          for (const item of items) {
            if (item.toLowerCase() === programName.toLowerCase()) {
              const fullPath = path.join(basePath, item);
              const stat = fs.statSync(fullPath);
              if (stat.isFile() && (stat.mode & parseInt('755', 8))) {
                return fullPath;
              }
            }
          }
        } catch (err) {
          continue;
        }
      }

      return null;
    }
  }
}

// ============================================================================
// WORKSPACE ENFORCEMENT ENGINE
// ============================================================================

class WorkspaceEnforcer {
  /**
   * Activate a workspace: apply all its rules
   */
  static activate(workspaceId) {
    const data = DataStore.read();
    const workspace = data.workspaces.find((w) => w.id === workspaceId);

    if (!workspace) {
      console.error(`Workspace not found: ${workspaceId}`);
      return false;
    }

    console.log(`\n========== [Workspace] Activating: ${workspace.name} ==========`);
    console.log(`[Workspace] Blocked: ${workspace.blocked?.length || 0} programs`);
    console.log(`[Workspace] Protected: ${workspace.protected?.length || 0} programs`);
    console.log(`[Workspace] AutoLaunch: ${workspace.autoLaunch?.length || 0} programs`);
    console.log(`[Workspace] Frozen: ${workspace.frozenProcesses?.length || 0} processes`);
    
    // Log the actual program IDs and names in each category
    if (workspace.blocked && workspace.blocked.length > 0) {
      workspace.blocked.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        console.log(`[Workspace] Blocked program: ${program ? program.name : 'Unknown'} (${programId})`);
      });
    }
    if (workspace.protected && workspace.protected.length > 0) {
      workspace.protected.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        console.log(`[Workspace] Protected program: ${program ? program.name : 'Unknown'} (${programId})`);
      });
    }
    if (workspace.autoLaunch && workspace.autoLaunch.length > 0) {
      workspace.autoLaunch.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        console.log(`[Workspace] AutoLaunch program: ${program ? program.name : 'Unknown'} (${programId})`);
      });
    }
    if (workspace.frozenProcesses && workspace.frozenProcesses.length > 0) {
      workspace.frozenProcesses.forEach((proc) => {
        console.log(`[Workspace] Frozen process: ${(proc?.name || 'Unknown')} - ${(proc?.title || '')}`);
      });
    }

    // Deactivate previous workspace
    if (activeWorkspaceId && activeWorkspaceId !== workspaceId) {
      this.deactivate(activeWorkspaceId);
    }

    activeWorkspaceId = workspaceId;
    workspace.status = 'active';

    // Persist the new active state
    DataStore.write(data);

    // Launch autoLaunch programs (automatically start when workspace activates)
    if (workspace.autoLaunch && workspace.autoLaunch.length > 0) {
      console.log(`[AutoLaunch] Found ${workspace.autoLaunch.length} auto-launch programs`);
      workspace.autoLaunch.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        if (program) {
          console.log(`[AutoLaunch] Launching: ${program.name} (${program.execPath})`);
          const launched = ProcessControl.launchProcess(program.execPath, program.args || []);
          console.log(`[AutoLaunch] Result for ${program.name}: ${launched ? 'SUCCESS' : 'FAILED'}`);
          // Track for relaunch if terminated
          enforcementState.watchers[programId] = {
            lastSeen: true, // Assume it's running after launch
            launchTime: Date.now(), // Initialize grace period
            workspaceId: workspaceId,
            type: 'autoLaunch', // Mark as autoLaunch type
          };
        }
      });
    }

    // Launch protected programs (also auto-launch, but with relaunch enforcement)
    if (workspace.protected && workspace.protected.length > 0) {
      console.log(`[Protected] Found ${workspace.protected.length} protected programs`);
      workspace.protected.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        if (program) {
          console.log(`[Protected] Launching: ${program.name} (${program.execPath})`);
          const launched = ProcessControl.launchProcess(program.execPath, program.args || []);
          console.log(`[Protected] Result for ${program.name}: ${launched ? 'SUCCESS' : 'FAILED'}`);
          // Track for relaunch if terminated
          enforcementState.watchers[programId] = {
            lastSeen: false, // Don't assume it's running until we see it
            launchTime: Date.now(), // Initialize grace period
            workspaceId: workspaceId,
            type: 'protected', // Mark as protected type
            everSeenRunning: false,
          };
        }
      });
    }

    // Start enforcement polling for blocked programs
    if (workspace.blocked && workspace.blocked.length > 0) {
      this._startBlockedPolling(workspaceId);
    }

    // Start enforcement polling for protected programs (keep them running if user starts them)
    if (workspace.protected && workspace.protected.length > 0) {
      this._startProtectedPolling(workspaceId);
    }

    // Start enforcement polling for autoLaunch programs (keep them running)
    if (workspace.autoLaunch && workspace.autoLaunch.length > 0) {
      this._startAutoLaunchPolling(workspaceId);
    }

    // Start enforcement polling for frozen processes (suspend when running)
    if (workspace.frozenProcesses && workspace.frozenProcesses.length > 0) {
      this._applyFrozenRules(workspaceId, workspace.frozenProcesses);
      this._startFrozenPolling(workspaceId);
    }

    // Activate DNS category blocking
    if (workspace.dnsCategories && workspace.dnsCategories.length > 0) {
      console.log(`[Workspace] Activating DNS categories: ${workspace.dnsCategories.join(', ')}`);
      DNSCategoryEnforcer.activate(workspaceId);
    }

    // Apply hosts file blocklist
    if (workspace.hostBlocklist && workspace.hostBlocklist.length > 0) {
      try {
        const applied = HostsBlocklistEnforcer.applyWorkspace(workspaceId, workspace.hostBlocklist);
        console.log(`[Workspace] Hosts blocklist applied: ${applied} hosts`);
      } catch (err) {
        console.error('[Workspace] Failed to apply hosts blocklist:', err.message);
      }
    }

    return true;
  }

  /**
   * Deactivate a workspace: stop all its rules
   */
  static deactivate(workspaceId) {
    const data = DataStore.read();
    const workspace = data.workspaces.find((w) => w.id === workspaceId);

    if (!workspace) {
      console.error(`Workspace not found: ${workspaceId}`);
      return false;
    }

    console.log(`Deactivating workspace: ${workspace.name}`);

    workspace.status = 'inactive';
    DataStore.write(data);

    // Clear all timers for this workspace
    if (enforcementState.timers[workspaceId]) {
      enforcementState.timers[workspaceId].forEach((timerId) =>
        clearInterval(timerId)
      );
      delete enforcementState.timers[workspaceId];
    }
    if (enforcementState.frozenTimers[workspaceId]) {
      delete enforcementState.frozenTimers[workspaceId];
    }
    if (enforcementState.blockedTimers[workspaceId]) {
      clearInterval(enforcementState.blockedTimers[workspaceId]);
      delete enforcementState.blockedTimers[workspaceId];
    }
    if (enforcementState.protectedTimers[workspaceId]) {
      clearInterval(enforcementState.protectedTimers[workspaceId]);
      delete enforcementState.protectedTimers[workspaceId];
    }
    if (enforcementState.autoLaunchTimers[workspaceId]) {
      clearInterval(enforcementState.autoLaunchTimers[workspaceId]);
      delete enforcementState.autoLaunchTimers[workspaceId];
    }

    // Clear watchers for programs in this workspace
    const allProgramIds = [
      ...(workspace.blocked || []),
      ...(workspace.protected || []),
      ...(workspace.autoLaunch || []),
    ];
    allProgramIds.forEach((programId) => {
      delete enforcementState.watchers[programId];
    });

    if (workspace.frozenProcesses && workspace.frozenProcesses.length > 0) {
      this._unfreezeWorkspaceProcesses(workspaceId, workspace.frozenProcesses);
    }

    Object.keys(enforcementState.frozen).forEach((key) => {
      if (enforcementState.frozen[key]?.workspaceId === workspaceId) {
        ProcessControl.showWindowForProcess(enforcementState.frozen[key]);
        delete enforcementState.frozen[key];
      }
    });

    if (activeWorkspaceId === workspaceId) {
      activeWorkspaceId = null;
    }

    try {
      HostsBlocklistEnforcer.removeWorkspace(workspaceId);
    } catch (err) {
      console.error('[Workspace] Failed to remove hosts blocklist:', err.message);
    }

    return true;
  }

  /**
   * Start polling for blocked programs
   */
  static _startBlockedPolling(workspaceId) {
    if (enforcementState.blockedTimers[workspaceId]) {
      return;
    }
    const timerId = setInterval(() => {
      // Only enforce if this workspace is still active
      if (activeWorkspaceId !== workspaceId) {
        return;
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === workspaceId);
      const blockedProgramIds = workspace?.blocked || [];
      blockedProgramIds.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        if (!program) return;
        const isShellApp = program.execPath?.toLowerCase().startsWith('shell:appsfolder\\');
        const isRunning = ProcessControl.isProcessRunning(program.execPath);
        const isRunningByTitle = isShellApp && ProcessControl._isRunningWindowsByTitle(program.name);
        if (isRunning || isRunningByTitle) {
          console.log(`Terminating blocked program: ${program.name}`);
          if (isShellApp) {
            ProcessControl._terminateWindowsByTitle(program.name);
          }
          ProcessControl.terminateProcess(program.execPath);
        }
      });
    }, POLLING_INTERVAL);

    if (!enforcementState.timers[workspaceId]) {
      enforcementState.timers[workspaceId] = [];
    }
    enforcementState.timers[workspaceId].push(timerId);
    enforcementState.blockedTimers[workspaceId] = timerId;
  }

  /**
   * Start polling for protected programs (relaunch if terminated)
   */
  static _startProtectedPolling(workspaceId) {
    if (enforcementState.protectedTimers[workspaceId]) {
      return;
    }
    const timerId = setInterval(() => {
      // Only enforce if this workspace is still active
      if (activeWorkspaceId !== workspaceId) {
        return;
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === workspaceId);
      const protectedProgramIds = workspace?.protected || [];
      const protectedIdSet = new Set(protectedProgramIds);

      Object.keys(enforcementState.watchers).forEach((programId) => {
        const watcher = enforcementState.watchers[programId];
        if (watcher?.workspaceId !== workspaceId || watcher?.type !== 'protected') return;
        if (!protectedIdSet.has(programId)) {
          delete enforcementState.watchers[programId];
        }
      });

      protectedProgramIds.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        if (!program) {
          return;
        }

        const isRunning = ProcessControl.isProcessRunning(program.execPath);
        const watcher = enforcementState.watchers[programId];

        // First time seeing this program - initialize watcher
        if (!watcher) {
          console.log(
            `[ProtectedPolling] Initializing watcher for ${program.name}, running: ${isRunning}`
          );
          if (!isRunning) {
            ProcessControl.launchProcess(program.execPath, program.args || []);
          }
          enforcementState.watchers[programId] = {
            lastSeen: isRunning,
            launchTime: Date.now(),
            workspaceId: workspaceId,
            type: 'protected',
            everSeenRunning: isRunning,
          };
          return;
        }

        // Grace period: don't check for termination within 5 seconds of launch
        // Programs need time to fully initialize
        const timeSinceLaunch = Date.now() - (watcher.launchTime || Date.now());
        const isInGracePeriod = timeSinceLaunch < 5000;

        if (isInGracePeriod) {
          // During grace period, keep assuming it's running
          console.log(
            `[ProtectedPolling] ${program.name} in grace period (${timeSinceLaunch}ms)`
          );
          watcher.lastSeen = isRunning;
          if (isRunning) {
            watcher.everSeenRunning = true;
          }
          return;
        }

        const isShellApp = program.execPath?.toLowerCase().startsWith('shell:appsfolder\\');
        const now = Date.now();
        const lastAttempt = watcher.lastLaunchAttempt || 0;
        const relaunchCooldownMs = 8000;

        // After grace period, detect termination: was running, now isn't
        if (!watcher.everSeenRunning && isRunning) {
          watcher.everSeenRunning = true;
        }

        // AppsFolder apps may not be detectable; allow periodic relaunch if not running
        if (isShellApp && !isRunning && (now - lastAttempt) > relaunchCooldownMs) {
          console.log(
            `[ProtectedPolling] ${program.name} not detected; relaunching AppsFolder app`
          );
          ProcessControl.launchProcess(program.execPath, program.args || []);
          watcher.launchTime = Date.now();
          watcher.lastLaunchAttempt = Date.now();
          watcher.lastSeen = false;
          return;
        }

        if (watcher.everSeenRunning && watcher.lastSeen && !isRunning) {
          console.log(
            `[ProtectedPolling] ${program.name} terminated, relaunching (was: ${watcher.lastSeen}, now: ${isRunning})`
          );
          ProcessControl.launchProcess(program.execPath, program.args || []);
          watcher.launchTime = Date.now(); // Reset grace period
          watcher.lastLaunchAttempt = Date.now();
          watcher.lastSeen = false;
          return;
        }

        // Log ongoing status
        if (isRunning !== watcher.lastSeen) {
          console.log(
            `[ProtectedPolling] ${program.name} status changed: ${watcher.lastSeen} â†’ ${isRunning}`
          );
        }

        watcher.lastSeen = isRunning;
      });
    }, POLLING_INTERVAL);

    if (!enforcementState.timers[workspaceId]) {
      enforcementState.timers[workspaceId] = [];
    }
    enforcementState.timers[workspaceId].push(timerId);
    enforcementState.protectedTimers[workspaceId] = timerId;
  }

  /**
   * Start polling for autoLaunch programs (only launch once on activation, don't relaunch if terminated)
   */
  static _startAutoLaunchPolling(workspaceId) {
    if (enforcementState.autoLaunchTimers[workspaceId]) {
      return;
    }
    const timerId = setInterval(() => {
      // Only enforce if this workspace is still active
      if (activeWorkspaceId !== workspaceId) {
        return;
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === workspaceId);
      const autoLaunchProgramIds = workspace?.autoLaunch || [];
      const autoLaunchIdSet = new Set(autoLaunchProgramIds);

      Object.keys(enforcementState.watchers).forEach((programId) => {
        const watcher = enforcementState.watchers[programId];
        if (watcher?.workspaceId !== workspaceId || watcher?.type !== 'autoLaunch') return;
        if (!autoLaunchIdSet.has(programId)) {
          delete enforcementState.watchers[programId];
        }
      });

      autoLaunchProgramIds.forEach((programId) => {
        const program = data.programs.find((p) => p.id === programId);
        if (!program) {
          return;
        }

        const isRunning = ProcessControl.isProcessRunning(program.execPath);
        const watcher = enforcementState.watchers[programId];

        // First time seeing this program - initialize watcher
        if (!watcher) {
          console.log(
            `[AutoLaunchPolling] Initializing watcher for ${program.name}, running: ${isRunning}`
          );
          if (!isRunning) {
            ProcessControl.launchProcess(program.execPath, program.args || []);
          }
          enforcementState.watchers[programId] = {
            lastSeen: true, // Assume it's running (we just launched it)
            launchTime: Date.now(),
            workspaceId: workspaceId,
            type: 'autoLaunch',
            launchedOnce: true, // Mark that we've already launched this program
          };
          return;
        }

        // Grace period: don't check for termination within 5 seconds of launch
        // Programs need time to fully initialize
        const timeSinceLaunch = Date.now() - (watcher.launchTime || Date.now());
        const isInGracePeriod = timeSinceLaunch < 5000;

        if (isInGracePeriod) {
          // During grace period, keep assuming it's running
          console.log(
            `[AutoLaunchPolling] ${program.name} in grace period (${timeSinceLaunch}ms)`
          );
          watcher.lastSeen = true;
          return;
        }

        // After grace period, detect termination: was running, now isn't
        // For autoLaunch programs, we do NOT relaunch them if they terminate
        // Auto-launch is a one-time launch on workspace activation only
        if (watcher.lastSeen && !isRunning) {
          console.log(
            `[AutoLaunchPolling] ${program.name} terminated, but auto-launch programs are not relaunched (was: ${watcher.lastSeen}, now: ${isRunning})`
          );
          // Do NOT relaunch - auto-launch is one-time only
          watcher.lastSeen = false;
          return;
        }

        // Log ongoing status
        if (isRunning !== watcher.lastSeen) {
          console.log(
            `[AutoLaunchPolling] ${program.name} status changed: ${watcher.lastSeen} â†’ ${isRunning}`
          );
        }

        watcher.lastSeen = isRunning;
      });
    }, POLLING_INTERVAL);

    if (!enforcementState.timers[workspaceId]) {
      enforcementState.timers[workspaceId] = [];
    }
    enforcementState.timers[workspaceId].push(timerId);
    enforcementState.blockedTimers[workspaceId] = timerId;
  }

  static _processKey(name, title) {
    const safeName = (name || '').toLowerCase();
    const safeTitle = (title || '').toLowerCase();
    if (!safeName && !safeTitle) return '';
    return `${safeName}|||${safeTitle}`.trim();
  }

  static _isIncognitoTitle(title) {
    const lower = (title || '').toLowerCase();
    if (!lower) return false;
    return lower.includes('incognito') || lower.includes('inprivate') || lower.includes('private');
  }

  static _matchesIncognitoFrozen(proc, frozenProcesses) {
    if (!proc || !ProcessControl.isChromiumProcessName(proc.name)) return false;
    if (!this._isIncognitoTitle(proc.title)) return false;
    const nameLower = (proc.name || '').toLowerCase();
    return (frozenProcesses || []).some((p) => {
      if (!p) return false;
      if ((p.name || '').toLowerCase() !== nameLower) return false;
      return this._isIncognitoTitle(p.title);
    });
  }

  static _isFrozenStateStillConfigured(state, frozenProcesses, keySet) {
    if (keySet.has(this._processKey(state?.name, state?.title))) return true;
    if (!ProcessControl.isChromiumProcessName(state?.name)) return false;
    if (!this._isIncognitoTitle(state?.title)) return false;
    const nameLower = (state?.name || '').toLowerCase();
    return (frozenProcesses || []).some((p) => {
      if (!p) return false;
      if ((p.name || '').toLowerCase() !== nameLower) return false;
      return this._isIncognitoTitle(p.title);
    });
  }

  static _applyFrozenRules(workspaceId, frozenProcesses) {
    const keySet = new Set(
      (frozenProcesses || []).map((proc) => this._processKey(proc?.name, proc?.title))
    );
    if (keySet.size === 0) return;

    const windowed = ProcessControl.getWindowedProcesses();
    windowed.forEach((proc) => {
      const key = this._processKey(proc.name, proc.title);
      if (!key) return;
      const shouldFreeze = keySet.has(key) || this._matchesIncognitoFrozen(proc, frozenProcesses);
      if (!shouldFreeze) return;
      if (ProcessControl._isCriticalName(proc.name)) return;

      const frozenState = enforcementState.frozen[key];
      if (frozenState?.frozen) return;

      if (ProcessControl.isChromiumProcessName(proc.name)) {
        ProcessControl.cdpSetLifecycleStateByTitle(proc.title, 'frozen')
          .then((ok) => {
            if (ok) {
              this._markFrozen(key, workspaceId, proc, 'cdp');
            } else {
              const throttled = ProcessControl.throttleProcessByPid(proc.pid);
              if (throttled) {
                this._markFrozen(key, workspaceId, proc, 'throttle');
              } else {
                console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
              }
            }
          })
          .catch(() => {
            const throttled = ProcessControl.throttleProcessByPid(proc.pid);
            if (throttled) {
              this._markFrozen(key, workspaceId, proc, 'throttle');
            } else {
              console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
            }
          });
        return;
      }

      const throttled = ProcessControl.throttleProcessByPid(proc.pid);
      if (throttled) {
        this._markFrozen(key, workspaceId, proc, 'throttle');
      } else {
        console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
      }
    });
  }

  static _startFrozenPolling(workspaceId) {
    if (enforcementState.frozenTimers[workspaceId]) {
      return;
    }

    const timerId = setInterval(() => {
      if (activeWorkspaceId !== workspaceId) {
        return;
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === workspaceId);
      const frozenProcesses = workspace?.frozenProcesses || [];
      const keySet = new Set(
        frozenProcesses.map((proc) => this._processKey(proc?.name, proc?.title))
      );

      const windowed = ProcessControl.getWindowedProcesses();
      const windowedMap = new Map(
        windowed.map((proc) => [this._processKey(proc.name, proc.title), proc])
      );

      // Freeze any matching windowed process that should be frozen
      windowed.forEach((proc) => {
        const key = this._processKey(proc.name, proc.title);
        if (!key) return;
        const shouldFreeze = keySet.has(key) || this._matchesIncognitoFrozen(proc, frozenProcesses);
        if (!shouldFreeze) return;
        if (ProcessControl._isCriticalName(proc.name)) return;

        const frozenState = enforcementState.frozen[key];
        if (frozenState?.frozen) return;

        if (ProcessControl.isChromiumProcessName(proc.name)) {
          ProcessControl.cdpSetLifecycleStateByTitle(proc.title, 'frozen')
            .then((ok) => {
              if (ok) {
                this._markFrozen(key, workspaceId, proc, 'cdp');
              } else {
                const throttled = ProcessControl.throttleProcessByPid(proc.pid);
                if (throttled) {
                  this._markFrozen(key, workspaceId, proc, 'throttle');
                } else {
                  console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
                }
              }
            })
            .catch(() => {
              const throttled = ProcessControl.throttleProcessByPid(proc.pid);
              if (throttled) {
                this._markFrozen(key, workspaceId, proc, 'throttle');
              } else {
                console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
              }
            });
          return;
        }

        const throttled = ProcessControl.throttleProcessByPid(proc.pid);
        if (throttled) {
          this._markFrozen(key, workspaceId, proc, 'throttle');
        } else {
          console.warn(`[Frozen] Failed to throttle PID ${proc.pid} (${proc.name}) title="${proc.title}"`);
        }
      });

      // Unfreeze if toggled off or window no longer present
      Object.keys(enforcementState.frozen).forEach((key) => {
        const state = enforcementState.frozen[key];
        if (state.workspaceId !== workspaceId) return;
        const stillConfigured = this._isFrozenStateStillConfigured(state, frozenProcesses, keySet);
        const currentProc = windowedMap.get(key);

        if (!stillConfigured) {
          if (state?.mode === 'cdp') {
            ProcessControl.cdpSetLifecycleStateByTitle(state?.title || '', 'active').catch(() => {});
          } else if (state?.mode === 'throttle' && currentProc?.pid) {
            ProcessControl.restorePriorityByPid(currentProc.pid);
          } else if (currentProc?.pid) {
            ProcessControl.unfreezeProcessByPid(currentProc.pid);
          }
          this._clearFrozen(key);
          return;
        }

        if (!currentProc) {
          if (state?.pid && ProcessControl.isPidRunning(state.pid)) {
            return;
          }
          this._clearFrozen(key);
        }
      });
    }, POLLING_INTERVAL);

    if (!enforcementState.timers[workspaceId]) {
      enforcementState.timers[workspaceId] = [];
    }
    enforcementState.timers[workspaceId].push(timerId);
    enforcementState.frozenTimers[workspaceId] = timerId;
  }

  static _unfreezeWorkspaceProcesses(workspaceId, frozenProcesses) {
    const keySet = new Set(
      (frozenProcesses || []).map((proc) => this._processKey(proc?.name, proc?.title))
    );
    const windowed = ProcessControl.getWindowedProcesses();

    windowed.forEach((proc) => {
      const key = this._processKey(proc.name, proc.title);
      if (!key || !keySet.has(key)) return;
      if (ProcessControl.isChromiumProcessName(proc.name)) {
        ProcessControl.cdpSetLifecycleStateByTitle(proc.title, 'active').catch(() => {});
      }
      ProcessControl.restorePriorityByPid(proc.pid);
      // Always attempt to show the window after unfreezing.
      ProcessControl.showWindowForProcess(proc);
      this._clearFrozen(key);
    });
  }

  static _markFrozen(key, workspaceId, proc, mode) {
    const hidden = ProcessControl.hideWindowForProcess(proc);
    enforcementState.frozen[key] = {
      frozen: true,
      workspaceId,
      since: Date.now(),
      pid: proc?.pid,
      name: proc?.name,
      title: proc?.title,
      mode: mode || 'throttle',
      hidden,
    };
    enforcementState.hiddenCache[key] = {
      pid: proc?.pid,
      name: proc?.name,
      title: proc?.title,
      workspaceId,
      since: Date.now(),
      hidden: true,
    };
  }

  static _clearFrozen(key) {
    if (!enforcementState.frozen[key]) return;
    const state = enforcementState.frozen[key];
    ProcessControl.showWindowForProcess(state);
    delete enforcementState.frozen[key];
  }
}

// ============================================================================
// IPC HANDLERS (Main â† â†’ Renderer)
// ============================================================================

function setupIPC() {
  // ---- Workspace Management ----

  ipcMain.handle('workspace:list', (event) => {
    try {
      const data = DataStore.read();
      return { success: true, workspaces: data.workspaces };
    } catch (err) {
      console.error('Error listing workspaces:', err);
      return {
        success: false,
        error: 'Failed to list workspaces',
      };
    }
  });

  ipcMain.handle('workspace:create', (event, payload) => {
    try {
      if (!payload || typeof payload.name !== 'string' || !payload.name.trim()) {
        return { success: false, error: 'Invalid workspace name' };
      }

      const data = DataStore.read();
      const newWorkspace = {
        id: `workspace_${Date.now()}`,
        name: payload.name.trim(),
        status: 'inactive',
        blocked: [],
        protected: [],
        autoLaunch: [],
        frozenProcesses: [],
        dnsCategories: [],
      };

      data.workspaces.push(newWorkspace);
      const success = DataStore.write(data);

      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true, workspace: newWorkspace };
      } else {
        return { success: false, error: 'Failed to save workspace' };
      }
    } catch (err) {
      console.error('Error creating workspace:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:activate', (event, payload) => {
    try {
      if (!payload || typeof payload.id !== 'string') {
        return { success: false, error: 'Invalid workspace ID' };
      }

      const success = WorkspaceEnforcer.activate(payload.id);
      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to activate workspace' };
      }
    } catch (err) {
      console.error('Error activating workspace:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:deactivate', (event, payload) => {
    try {
      if (!payload || typeof payload.id !== 'string') {
        return { success: false, error: 'Invalid workspace ID' };
      }

      const success = WorkspaceEnforcer.deactivate(payload.id);
      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to deactivate workspace' };
      }
    } catch (err) {
      console.error('Error deactivating workspace:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:delete', (event, payload) => {
    try {
      if (!payload || typeof payload.id !== 'string') {
        return { success: false, error: 'Invalid workspace ID' };
      }

      const data = DataStore.read();
      const index = data.workspaces.findIndex((w) => w.id === payload.id);

      if (index === -1) {
        return { success: false, error: 'Workspace not found' };
      }

      // If active, deactivate first
      if (activeWorkspaceId === payload.id) {
        WorkspaceEnforcer.deactivate(payload.id);
      }

      data.workspaces.splice(index, 1);
      const success = DataStore.write(data);

      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to delete workspace' };
      }
    } catch (err) {
      console.error('Error deleting workspace:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  // ---- Program Management ----

  ipcMain.handle('program:list', (event) => {
    try {
      const data = DataStore.read();
      return { success: true, programs: data.programs };
    } catch (err) {
      console.error('Error listing programs:', err);
      return { success: false, error: 'Failed to list programs' };
    }
  });

  ipcMain.handle('program:create', (event, payload) => {
    try {
      if (
        !payload ||
        typeof payload.name !== 'string' ||
        typeof payload.execPath !== 'string'
      ) {
        return { success: false, error: 'Invalid program data' };
      }

      const data = DataStore.read();
      const newProgram = {
        id: `program_${Date.now()}`,
        name: payload.name.trim(),
        execPath: payload.execPath.trim(),
        args: Array.isArray(payload.args) ? payload.args : [],
      };

      data.programs.push(newProgram);
      const success = DataStore.write(data);

      if (success) {
        mainWindow?.webContents.send('program:updated');
        return { success: true, program: newProgram };
      } else {
        return { success: false, error: 'Failed to save program' };
      }
    } catch (err) {
      console.error('Error creating program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('program:delete', (event, payload) => {
    try {
      if (!payload || typeof payload.id !== 'string') {
        return { success: false, error: 'Invalid program ID' };
      }

      const data = DataStore.read();
      const index = data.programs.findIndex((p) => p.id === payload.id);

      if (index === -1) {
        return { success: false, error: 'Program not found' };
      }

      const programToDelete = data.programs[index];

      // Remove from all workspaces
      data.workspaces.forEach((ws) => {
        ws.blocked = ws.blocked?.filter((id) => id !== payload.id) || [];
        ws.protected = ws.protected?.filter((id) => id !== payload.id) || [];
        ws.autoLaunch = ws.autoLaunch?.filter((id) => id !== payload.id) || [];
      });

      data.programs.splice(index, 1);
      const success = DataStore.write(data);

      if (success) {
        mainWindow?.webContents.send('program:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to delete program' };
      }
    } catch (err) {
      console.error('Error deleting program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  // ---- Workspace Program Association ----

  ipcMain.handle('workspace:addBlocked', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      const program = data.programs.find((p) => p.id === payload.programId);

      if (!workspace || !program) {
        return { success: false, error: 'Workspace or program not found' };
      }

      if (!workspace.blocked) {
        workspace.blocked = [];
      }
      if (!workspace.blocked.includes(payload.programId)) {
        workspace.blocked.push(payload.programId);
      }

      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId && program) {
          if (ProcessControl.isProcessRunning(program.execPath)) {
            ProcessControl.terminateProcess(program.execPath);
          }
          WorkspaceEnforcer._startBlockedPolling(payload.workspaceId);
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error adding blocked program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:removeBlocked', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);

      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      workspace.blocked = workspace.blocked?.filter(
        (id) => id !== payload.programId
      ) || [];

      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId && workspace.blocked.length === 0) {
          if (enforcementState.blockedTimers[payload.workspaceId]) {
            clearInterval(enforcementState.blockedTimers[payload.workspaceId]);
            delete enforcementState.blockedTimers[payload.workspaceId];
          }
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error removing blocked program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:addProtected', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      const program = data.programs.find((p) => p.id === payload.programId);

      if (!workspace || !program) {
        return { success: false, error: 'Workspace or program not found' };
      }

      if (!workspace.protected) {
        workspace.protected = [];
      }
      if (!workspace.protected.includes(payload.programId)) {
        workspace.protected.push(payload.programId);
      }

      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId && program) {
          ProcessControl.launchProcess(program.execPath, program.args || []);
          enforcementState.watchers[payload.programId] = {
            lastSeen: false,
            launchTime: Date.now(),
            workspaceId: payload.workspaceId,
            type: 'protected',
            everSeenRunning: false,
          };
          WorkspaceEnforcer._startProtectedPolling(payload.workspaceId);
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error adding protected program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:removeProtected', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);

      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      workspace.protected = workspace.protected?.filter(
        (id) => id !== payload.programId
      ) || [];

      const success = DataStore.write(data);
      if (success) {
        delete enforcementState.watchers[payload.programId];
        if (activeWorkspaceId === payload.workspaceId && workspace.protected.length === 0) {
          if (enforcementState.protectedTimers[payload.workspaceId]) {
            clearInterval(enforcementState.protectedTimers[payload.workspaceId]);
            delete enforcementState.protectedTimers[payload.workspaceId];
          }
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error removing protected program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:addAutoLaunch', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      const program = data.programs.find((p) => p.id === payload.programId);

      if (!workspace || !program) {
        return { success: false, error: 'Workspace or program not found' };
      }

      if (!workspace.autoLaunch) {
        workspace.autoLaunch = [];
      }
      if (!workspace.autoLaunch.includes(payload.programId)) {
        workspace.autoLaunch.push(payload.programId);
      }

      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId && program) {
          ProcessControl.launchProcess(program.execPath, program.args || []);
          enforcementState.watchers[payload.programId] = {
            lastSeen: true,
            launchTime: Date.now(),
            workspaceId: payload.workspaceId,
            type: 'autoLaunch',
            launchedOnce: true,
          };
          WorkspaceEnforcer._startAutoLaunchPolling(payload.workspaceId);
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error adding autoLaunch program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:removeAutoLaunch', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.programId) {
        return { success: false, error: 'Invalid workspace or program ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);

      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      workspace.autoLaunch = workspace.autoLaunch?.filter(
        (id) => id !== payload.programId
      ) || [];

      const success = DataStore.write(data);
      if (success) {
        delete enforcementState.watchers[payload.programId];
        if (activeWorkspaceId === payload.workspaceId && workspace.autoLaunch.length === 0) {
          if (enforcementState.autoLaunchTimers[payload.workspaceId]) {
            clearInterval(enforcementState.autoLaunchTimers[payload.workspaceId]);
            delete enforcementState.autoLaunchTimers[payload.workspaceId];
          }
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error removing autoLaunch program:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:toggleFrozenProcess', (event, payload) => {
    try {
      if (!payload?.workspaceId || typeof payload?.enabled !== 'boolean') {
        return { success: false, error: 'Invalid workspace or toggle state' };
      }
      if (!payload?.title) {
        return { success: false, error: 'Invalid process title' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      if (!workspace.frozenProcesses) {
        workspace.frozenProcesses = [];
      }

      const key = WorkspaceEnforcer._processKey(payload.name, payload.title);
      const existingIndex = workspace.frozenProcesses.findIndex(
        (p) => WorkspaceEnforcer._processKey(p?.name, p?.title) === key
      );

      if (payload.enabled && existingIndex === -1) {
        workspace.frozenProcesses.push({ name: payload.name, title: payload.title });
      }

      if (!payload.enabled && existingIndex !== -1) {
        workspace.frozenProcesses.splice(existingIndex, 1);
        const frozenState = enforcementState.frozen[key];
        if (frozenState) {
          if (frozenState.mode === 'cdp') {
            ProcessControl.cdpSetLifecycleStateByTitle(frozenState.title || '', 'active').catch(() => {});
          } else if (frozenState.mode === 'throttle' && frozenState.pid) {
            ProcessControl.restorePriorityByPid(frozenState.pid);
          } else if (frozenState.pid) {
            ProcessControl.unfreezeProcessByPid(frozenState.pid);
          }
          ProcessControl.showWindowForProcess(frozenState);
          WorkspaceEnforcer._clearFrozen(key);
        } else {
          // No tracked frozen state, but still ensure the window is shown.
          ProcessControl.showWindowForProcess({
            name: payload.name || '',
            title: payload.title || '',
          });
        }
      }

      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId) {
          WorkspaceEnforcer._applyFrozenRules(payload.workspaceId, workspace.frozenProcesses);
          WorkspaceEnforcer._startFrozenPolling(payload.workspaceId);
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error toggling frozen process:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  // ---- DNS Category Management ----

  ipcMain.handle('dns:getConfig', (event) => {
    try {
      const dnsService = new DNSService();
      return { success: true, config: dnsService.config };
    } catch (err) {
      console.error('Error getting DNS config:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('dns:saveConfig', (event, payload) => {
    try {
      const dnsService = new DNSService();
      dnsService.config = { ...dnsService.config, ...payload };
      const success = dnsService.saveConfig();
      if (success) {
        return { success: true };
      } else {
        return { success: false, error: 'Failed to save DNS config' };
      }
    } catch (err) {
      console.error('Error saving DNS config:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('dns:testConnection', async (event) => {
    try {
      const dnsService = new DNSService();
      const success = await dnsService.testConnection();
      return { success: success };
    } catch (err) {
      console.error('Error testing DNS connection:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dns:getCategories', async (event) => {
    try {
      const dnsService = new DNSService();
      const categories = await dnsService.getAvailableCategories();
      return { success: true, categories: categories };
    } catch (err) {
      console.error('Error getting DNS categories:', err);
      return { success: false, error: 'Internal error', categories: [] };
    }
  });

  ipcMain.handle('workspace:addDNSTag', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.categoryId) {
        return { success: false, error: 'Invalid workspace or category ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);

      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      if (!workspace.dnsCategories) {
        workspace.dnsCategories = [];
      }
      if (!workspace.dnsCategories.includes(payload.categoryId)) {
        workspace.dnsCategories.push(payload.categoryId);
      }

      const success = DataStore.write(data);
      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error adding DNS category:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:removeDNSTag', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.categoryId) {
        return { success: false, error: 'Invalid workspace or category ID' };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);

      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      workspace.dnsCategories = workspace.dnsCategories?.filter(
        (id) => id !== payload.categoryId
      ) || [];

      const success = DataStore.write(data);
      if (success) {
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      } else {
        return { success: false, error: 'Failed to update workspace' };
      }
    } catch (err) {
      console.error('Error removing DNS category:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  // ---- Status Queries ----

  ipcMain.handle('workspace:getActive', (event) => {
    try {
      if (!activeWorkspaceId) {
        return { success: true, activeWorkspaceId: null };
      }

      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === activeWorkspaceId);

      return {
        success: true,
        activeWorkspaceId: workspace?.id || null,
        activeWorkspaceName: workspace?.name || null,
      };
    } catch (err) {
      console.error('Error getting active workspace:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('system:getInfo', (event) => {
    try {
      return {
        success: true,
        platform: process.platform,
        nodeVersion: process.version,
        appVersion: app.getVersion(),
      };
    } catch (err) {
      console.error('Error getting system info:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('system:hostsStatus', (event) => {
    try {
      const hostsPath = HostsBlocklistEnforcer._hostsPath();
      let canWrite = false;
      try {
        const fd = fs.openSync(hostsPath, 'a');
        fs.closeSync(fd);
        canWrite = true;
      } catch (err) {
        canWrite = false;
      }
      return { success: true, canWrite, path: hostsPath };
    } catch (err) {
      console.error('Error checking hosts status:', err);
      return { success: false, error: 'Internal error', canWrite: false };
    }
  });


  // ---- Hosts File Blocklist ----

  ipcMain.handle('workspace:addHostBlock', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.host) {
        return { success: false, error: 'Invalid workspace or host' };
      }
      try {
        const fd = fs.openSync(HostsBlocklistEnforcer._hostsPath(), 'a'); fs.closeSync(fd);
      } catch (err) {
        return { success: false, error: 'Hosts file is not writable. Run as Administrator.' };
      }
      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }
      const normalized = HostsBlocklistEnforcer._normalizeHost(payload.host);
      if (!normalized) {
        return { success: false, error: 'Invalid host' };
      }
      if (!workspace.hostBlocklist) {
        workspace.hostBlocklist = [];
      }
      if (!workspace.hostBlocklist.includes(normalized)) {
        workspace.hostBlocklist.push(normalized);
      }
      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId) {
          try {
            HostsBlocklistEnforcer.applyWorkspace(payload.workspaceId, workspace.hostBlocklist);
          } catch (err) {
            return { success: false, error: `Failed to write hosts file: ${err.message}` };
          }
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true, host: normalized };
      }
      return { success: false, error: 'Failed to update workspace' };
    } catch (err) {
      console.error('Error adding host block:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('workspace:removeHostBlock', (event, payload) => {
    try {
      if (!payload?.workspaceId || !payload?.host) {
        return { success: false, error: 'Invalid workspace or host' };
      }
      try {
        const fd = fs.openSync(HostsBlocklistEnforcer._hostsPath(), 'a'); fs.closeSync(fd);
      } catch (err) {
        return { success: false, error: 'Hosts file is not writable. Run as Administrator.' };
      }
      const data = DataStore.read();
      const workspace = data.workspaces.find((w) => w.id === payload.workspaceId);
      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }
      workspace.hostBlocklist = (workspace.hostBlocklist || []).filter(
        (host) => host !== payload.host
      );
      const success = DataStore.write(data);
      if (success) {
        if (activeWorkspaceId === payload.workspaceId) {
          try {
            HostsBlocklistEnforcer.applyWorkspace(payload.workspaceId, workspace.hostBlocklist);
          } catch (err) {
            return { success: false, error: `Failed to write hosts file: ${err.message}` };
          }
        }
        mainWindow?.webContents.send('workspace:updated');
        return { success: true };
      }
      return { success: false, error: 'Failed to update workspace' };
    } catch (err) {
      console.error('Error removing host block:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('process:running:list', (event) => {
    try {
      const data = DataStore.read();
      let runningPrograms = [];
      let windowedPrograms = [];
      let debugProcessCount = 0;
      let debugWindowTitleCount = 0;
      let unmatchedWindowTitles = [];
      let windowTitles = [];
      let hiddenWindowTitles = [];

      if (process.platform === 'win32') {
        const snapshot = ProcessControl._getWindowsProcessSnapshot();
        const windowed = ProcessControl.getWindowedProcesses();
        debugProcessCount = snapshot.length;
        debugWindowTitleCount = windowed.length;
        const pidPathMap = new Map(
          snapshot
            .filter((proc) => proc && proc.Id)
            .map((proc) => [Number(proc.Id), (proc.Path || '').toString()])
        );
        const { runningIds, windowedIds } = ProcessControl._matchProgramsAgainstWindowsSnapshot(
          data.programs,
          snapshot
        );
        runningPrograms = data.programs.filter((program) => runningIds.has(program.id));
        windowedPrograms = data.programs.filter((program) => windowedIds.has(program.id));

        windowTitles = windowed.map((proc) => ({
          name: proc.name || '',
          title: proc.title || '',
          path: proc.path || pidPathMap.get(Number(proc.pid)) || '',
          execPath: proc.name || '',
          pid: proc.pid,
        }));

        const normalizedPrograms = data.programs.map((program) => ({
          id: program.id,
          name: (program.name || '').toLowerCase(),
          exec: (program.execPath || '').toLowerCase(),
        }));

        unmatchedWindowTitles = snapshot
          .map((proc) => ({
            name: (proc?.Name || '').toString(),
            title: (proc?.MainWindowTitle || '').toString(),
            path: (proc?.Path || '').toString(),
          }))
          .filter((proc) => proc.title.trim().length > 0)
          .filter((proc) => {
            const procNameLower = proc.name.toLowerCase();
            const procPathLower = proc.path.toLowerCase();
            const titleLower = proc.title.toLowerCase();

            const isMatched = normalizedPrograms.some((program) => {
              const execBase = program.exec.endsWith('.exe')
                ? path.basename(program.exec).replace(/\.exe$/i, '')
                : '';
              const nameMatch = program.name && procNameLower === program.name;
              const pathMatch = program.exec && procPathLower.endsWith(path.basename(program.exec));
              const titleMatch = program.name && titleLower.includes(program.name);
              const execBaseMatch = execBase && procNameLower === execBase;
              return nameMatch || pathMatch || titleMatch || execBaseMatch;
            });

            return !isMatched;
          })
          .slice(0, 100);
      } else {
        runningPrograms = data.programs
          .filter((program) => ProcessControl.isProgramRunning(program));
        windowedPrograms = runningPrograms
          .filter((program) => ProcessControl.hasVisibleWindow(program.execPath));

        const windowed = ProcessControl.getWindowedProcesses();
        debugProcessCount = windowed.length;
        debugWindowTitleCount = windowed.length;
        windowTitles = windowed.map((proc) => ({
          name: proc.name || '',
          title: proc.title || '',
          path: '',
          execPath: proc.name || '',
          pid: proc.pid,
        }));
      }

      const hiddenEntries = Object.entries(enforcementState.hiddenCache || {})
        .map(([key, value]) => ({
          key,
          value,
        }))
        .filter(({ value }) => value && value.title);

      if (hiddenEntries.length > 0) {
        const visibleKeys = new Set(
          windowTitles.map((proc) => WorkspaceEnforcer._processKey(proc.name, proc.title))
        );
        hiddenEntries.forEach(({ key, value }) => {
          if (value?.pid && !ProcessControl.isPidRunning(value.pid)) {
            value.pid = null;
          }
          if (visibleKeys.has(key)) {
            delete enforcementState.hiddenCache[key];
            return;
          }
          const hiddenProc = {
            name: value.name || '',
            title: value.title || '',
            path: '',
            execPath: value.name || '',
            pid: value.pid,
            hidden: true,
          };
          windowTitles.push(hiddenProc);
          hiddenWindowTitles.push(hiddenProc);
        });
      }

      const runningProgramIds = runningPrograms.map((program) => program.id);
      const windowedProgramIds = windowedPrograms.map((program) => program.id);
      const frozenStates = Object.values(enforcementState.frozen)
        .filter((state) => state)
        .map((state) => ({
          title: state.title || '',
          name: state.name || '',
          mode: state.mode || 'throttle',
          workspaceId: state.workspaceId || null,
          pid: state.pid,
        }));
      const frozenProcessEntries = Object.values(enforcementState.frozen)
        .filter((state) => state && (state.title || '').trim().length > 0)
        .map((state) => ({
          name: state.name || '',
          title: state.title || '',
          path: '',
          execPath: state.name || '',
          pid: state.pid,
          hidden: true,
        }));

      if (frozenProcessEntries.length > 0) {
        const existingKeys = new Set(
          windowTitles.map((proc) => WorkspaceEnforcer._processKey(proc.name, proc.title))
        );
        frozenProcessEntries.forEach((proc) => {
          const key = WorkspaceEnforcer._processKey(proc.name, proc.title);
          if (key && !existingKeys.has(key)) {
            windowTitles.push(proc);
            existingKeys.add(key);
          }
        });
      }

      return {
        success: true,
        runningProgramIds,
        windowedProgramIds,
        activeWorkspaceId,
        ownWindowPid: mainWindow?.webContents?.getOSProcessId?.() || null,
        ownBrowserPid: process.pid,
        debugProcessCount,
        debugWindowTitleCount,
        unmatchedWindowTitles: process.platform === 'win32' ? unmatchedWindowTitles : [],
        windowTitles,
        hiddenWindowTitles,
        frozenStates,
      };
    } catch (err) {
      console.error('Error getting running process list:', err);
      return { success: false, error: 'Internal error' };
    }
  });

  ipcMain.handle('process:showWindow', (event, payload) => {
    try {
      if (!payload || (!payload.pid && !payload.title)) {
        return { success: false, error: 'Invalid process' };
      }
      const ok = ProcessControl.showWindowForProcess(payload);
      if (ok) {
        const key = WorkspaceEnforcer._processKey(payload.name, payload.title);
        if (key && enforcementState.hiddenCache[key]) {
          delete enforcementState.hiddenCache[key];
        }
      }
      return { success: ok };
    } catch (err) {
      console.error('Error showing window:', err);
      return { success: false, error: 'Failed to show window' };
    }
  });

  ipcMain.handle('process:window:thumbnails', async (event, payload) => {
    try {
      const width = Math.max(64, Math.min(Number(payload?.width) || 240, 640));
      const height = Math.max(48, Math.min(Number(payload?.height) || 150, 480));
      const now = Date.now();
      const cacheWindowMs = 5000;
      if (lastThumbnailResult && now - lastThumbnailAt < cacheWindowMs) {
        return lastThumbnailResult;
      }
      if (thumbnailInFlight) {
        return await thumbnailInFlight;
      }

      thumbnailInFlight = (async () => {
      if (process.platform === 'win32') {
        const helperPath = ProcessControl._getWindowsSuspendHelperPath();
        if (!helperPath || !fs.existsSync(helperPath)) {
          return {
            success: false,
            error: 'Thumbnail helper not found',
            thumbnails: [],
            debug: { via: 'helper', windowCount: 0, screenCount: 0, allCount: 0, hasCapturer: false },
          };
        }

        const output = await new Promise((resolve, reject) => {
          execFile(
            helperPath,
            ['thumbs', String(width), String(height)],
            {
              encoding: 'utf-8',
              windowsHide: true,
              maxBuffer: 50 * 1024 * 1024,
              timeout: 15000,
            },
            (err, stdout) => {
              if (err) {
                if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
                  return resolve('');
                }
                return reject(err);
              }
              resolve(stdout || '');
            }
          );
        });

        const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
        const thumbnails = lines.map((line) => {
          const parts = line.split('|||');
          const pidRaw = parts.shift();
          const name = parts.shift() || '';
          const title = parts.shift() || '';
          const base64 = parts.join('|||') || '';
          return {
            id: `pid:${pidRaw || ''}`,
            title,
            name,
            pid: Number(pidRaw),
            thumbnail: base64 ? `data:image/png;base64,${base64}` : '',
            appIcon: '',
          };
        });

        return {
          success: true,
          thumbnails,
          debug: {
            hasCapturer: false,
            allCount: thumbnails.length,
            windowCount: thumbnails.length,
            screenCount: 0,
            via: 'helper',
          },
        };
      }

      const win = await getCaptureWindowReady();
      const sources = await win.webContents.executeJavaScript(
        `window.__getDesktopSources(${width}, ${height})`,
        true
      );

      if (sources && sources.__error) {
        console.error('Capture window debug:', sources.__debug);
        throw new Error(sources.__error);
      }

      const windowSources = sources.filter((source) => (source.id || '').startsWith('window:'));
      const screenSources = sources.filter((source) => (source.id || '').startsWith('screen:'));
      return {
        success: true,
        thumbnails: windowSources,
        debug: {
          hasCapturer: true,
          allCount: sources.length,
          windowCount: windowSources.length,
          screenCount: screenSources.length,
          via: 'captureWindow',
        },
      };
      })();

      const result = await thumbnailInFlight;
      lastThumbnailResult = result;
      lastThumbnailAt = Date.now();
      return result;
    } catch (err) {
      console.error('Error capturing window thumbnails:', err);
      if (lastThumbnailResult) {
        return lastThumbnailResult;
      }
      return {
        success: false,
        error: err?.message || 'Failed to get window thumbnails',
        thumbnails: [],
        debug: {
          hasCapturer: false,
          allCount: 0,
          windowCount: 0,
          screenCount: 0,
          via: 'captureWindow',
        },
      };
    } finally {
      thumbnailInFlight = null;
    }
  });

  // ---- Program Discovery ----

  ipcMain.handle('program:discover', async (event) => {
    try {
      _startDiscoveryWorker();
      const programs = _getDiscoveryResultsFiltered();
      programs.sort((a, b) => a.name.localeCompare(b.name));

      return {
        success: true,
        programs,
        status: discoveryState.status,
        startedAt: discoveryState.startedAt,
        finishedAt: discoveryState.finishedAt,
      };
    } catch (err) {
      console.error('Error discovering programs:', err);
      return { success: false, error: 'Failed to discover programs', programs: [] };
    }
  });


  ipcMain.handle('program:addDiscovered', (event, payload) => {
    try {
      if (
        !payload ||
        typeof payload.name !== 'string' ||
        typeof payload.execPath !== 'string'
      ) {
        return { success: false, error: 'Invalid program data' };
      }

      const data = DataStore.read();

      // Check if already exists
      if (data.programs.find((p) => p.execPath === payload.execPath)) {
        return { success: false, error: 'Program already exists' };
      }

      const newProgram = {
        id: `program_${Date.now()}`,
        name: payload.name.trim(),
        execPath: payload.execPath.trim(),
        args: [],
      };

      data.programs.push(newProgram);
      const success = DataStore.write(data);

      if (success) {
        mainWindow?.webContents.send('program:updated');

        // If adding to workspace, do that too
        if (payload.workspaceId && payload.ruleType) {
          const workspace = data.workspaces.find(
            (w) => w.id === payload.workspaceId
          );
          if (workspace) {
            if (payload.ruleType === 'blocked') {
              if (!workspace.blocked) workspace.blocked = [];
              if (!workspace.blocked.includes(newProgram.id)) {
                workspace.blocked.push(newProgram.id);
              }
            } else if (payload.ruleType === 'protected') {
              if (!workspace.protected) workspace.protected = [];
              if (!workspace.protected.includes(newProgram.id)) {
                workspace.protected.push(newProgram.id);
              }
            } else if (payload.ruleType === 'autoLaunch') {
              if (!workspace.autoLaunch) workspace.autoLaunch = [];
              if (!workspace.autoLaunch.includes(newProgram.id)) {
                workspace.autoLaunch.push(newProgram.id);
              }
            }
            DataStore.write(data);
            mainWindow?.webContents.send('workspace:updated');
          }
        }

        return { success: true, program: newProgram };
      } else {
        return { success: false, error: 'Failed to save program' };
      }
    } catch (err) {
      console.error('Error adding discovered program:', err);
      return { success: false, error: 'Internal error' };
    }
  });
}

// ============================================================================
// ELECTRON LIFECYCLE
// ============================================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    return captureWindow;
  }
  captureWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload/capture-preload.js'),
    },
  });

  captureWindow.loadURL('about:blank');
  captureWindow.on('closed', () => {
    captureWindow = null;
  });
  return captureWindow;
}

async function getCaptureWindowReady() {
  const win = getCaptureWindow();
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
    });
  }
  return win;
}

app.on('ready', () => {
  DataStore.initialize();
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ============================================================================
// DNS CATEGORY BLOCKING SERVICE
// ============================================================================

class DNSService {
  constructor() {
    this.config = this.loadConfig();
    this.activeCategories = new Set();
    this.dnsServer = null;
    this.originalDNS = null;
  }

  loadConfig() {
    const configPath = path.join(app.getPath('userData'), 'dns-config.json');
    const defaultConfig = {
      provider: 'nextdns',
      apiKey: '',
      profileId: '',
      customCategories: [],
      enabled: false,
      port: 53535,
      upstreamDNS: ['8.8.8.8', '8.8.4.4']
    };

    try {
      if (fs.existsSync(configPath)) {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return { ...defaultConfig, ...savedConfig };
      } else {
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
      }
    } catch (err) {
      console.error('Error loading DNS config:', err);
      return defaultConfig;
    }
  }

  saveConfig() {
    const configPath = path.join(app.getPath('userData'), 'dns-config.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      return true;
    } catch (err) {
      console.error('Error saving DNS config:', err);
      return false;
    }
  }

  async testConnection() {
    try {
      if (this.config.provider === 'nextdns') {
        const url = `https://api.nextdns.io/profiles/${this.config.profileId}/settings`;
        const response = await this.makeRequest(url, 'GET', {
          'X-Api-Key': this.config.apiKey
        });
        return response.status === 200;
      }
      return false;
    } catch (err) {
      console.error('DNS provider connection test failed:', err);
      return false;
    }
  }

  async getAvailableCategories() {
    try {
      if (this.config.provider === 'nextdns') {
        const url = `https://api.nextdns.io/profiles/${this.config.profileId}/settings`;
        const response = await this.makeRequest(url, 'GET', {
          'X-Api-Key': this.config.apiKey
        });

        if (response.status === 200) {
          const data = JSON.parse(response.body);
          return this.parseNextDNSSettings(data);
        }
      }
      return [];
    } catch (err) {
      console.error('Error fetching categories:', err);
      return [];
    }
  }

  parseNextDNSSettings(data) {
    const categories = [];
    const settings = data.data || {};

    // NextDNS standard categories
    const standardCategories = [
      { id: 'abuse', name: 'Abuse', enabled: settings.blockMalware },
      { id: 'adult', name: 'Adult Content', enabled: settings.blockAdult },
      { id: 'ads', name: 'Ads', enabled: settings.blockAds },
      { id: 'cryptominers', name: 'Cryptominers', enabled: settings.blockCryptominers },
      { id: 'dns-rebind', name: 'DNS Rebind', enabled: settings.blockDnsRebind },
      { id: 'phishing', name: 'Phishing', enabled: settings.blockPhishing },
      { id: 'privacy', name: 'Privacy', enabled: settings.blockPrivacy },
      { id: 'redirect', name: 'Redirect', enabled: settings.blockRedirect },
      { id: 'social', name: 'Social Media', enabled: settings.blockSocial },
      { id: 'trackers', name: 'Trackers', enabled: settings.blockTrackers },
      { id: 'gambling', name: 'Gambling', enabled: settings.blockGambling },
      { id: 'malware', name: 'Malware', enabled: settings.blockMalware },
      { id: 'fraud', name: 'Fraud', enabled: settings.blockFraud }
    ];

    return standardCategories;
  }

  async enableCategories(categoryIds) {
    try {
      if (this.config.provider === 'nextdns') {
        const settings = await this.getAvailableCategories();
        const updates = {};

        // Update settings based on selected categories
        settings.forEach(category => {
          if (categoryIds.includes(category.id)) {
            updates[`block${category.name.replace(/\s+/g, '')}`] = true;
          }
        });

        const url = `https://api.nextdns.io/profiles/${this.config.profileId}/settings`;
        const response = await this.makeRequest(url, 'PATCH', {
          'X-Api-Key': this.config.apiKey,
          'Content-Type': 'application/json'
        }, JSON.stringify(updates));

        if (response.status === 200) {
          this.activeCategories = new Set(categoryIds);
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error('Error enabling categories:', err);
      return false;
    }
  }

  async disableCategories(categoryIds) {
    try {
      if (this.config.provider === 'nextdns') {
        const updates = {};

        // Disable specified categories
        categoryIds.forEach(categoryId => {
          const settingName = this.getSettingName(categoryId);
          if (settingName) {
            updates[settingName] = false;
          }
        });

        const url = `https://api.nextdns.io/profiles/${this.config.profileId}/settings`;
        const response = await this.makeRequest(url, 'PATCH', {
          'X-Api-Key': this.config.apiKey,
          'Content-Type': 'application/json'
        }, JSON.stringify(updates));

        if (response.status === 200) {
          categoryIds.forEach(id => this.activeCategories.delete(id));
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error('Error disabling categories:', err);
      return false;
    }
  }

  getSettingName(categoryId) {
    const mapping = {
      'abuse': 'blockMalware', // NextDNS groups abuse with malware
      'adult': 'blockAdult',
      'ads': 'blockAds',
      'cryptominers': 'blockCryptominers',
      'dns-rebind': 'blockDnsRebind',
      'phishing': 'blockPhishing',
      'privacy': 'blockPrivacy',
      'redirect': 'blockRedirect',
      'social': 'blockSocial',
      'trackers': 'blockTrackers',
      'gambling': 'blockGambling',
      'malware': 'blockMalware',
      'fraud': 'blockFraud'
    };
    return mapping[categoryId];
  }

  async makeRequest(url, method, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: headers
      };

      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  async startLocalDNSServer() {
    if (this.dnsServer) return true;

    try {
      const dgram = require('dgram');
      this.dnsServer = dgram.createSocket('udp4');

      this.dnsServer.on('error', (err) => {
        console.error('DNS server error:', err);
        this.dnsServer.close();
        this.dnsServer = null;
      });

      this.dnsServer.on('message', (msg, rinfo) => {
        this.handleDNSQuery(msg, rinfo);
      });

      this.dnsServer.bind(this.config.port, () => {
        console.log(`Local DNS server listening on port ${this.config.port}`);
      });

      return true;
    } catch (err) {
      console.error('Error starting DNS server:', err);
      return false;
    }
  }

  async stopLocalDNSServer() {
    if (this.dnsServer) {
      this.dnsServer.close();
      this.dnsServer = null;
      console.log('Local DNS server stopped');
    }
  }

  handleDNSQuery(msg, rinfo) {
    // Simple DNS proxy implementation
    // In a full implementation, this would check against blocked categories
    // and return NXDOMAIN for blocked domains
    const dnsPacket = require('dns-packet');
    const response = dnsPacket.decode(msg);

    // For now, just forward to upstream DNS
    const client = require('dgram').createSocket('udp4');
    const upstream = this.config.upstreamDNS[0];
    const port = 53;

    client.send(msg, 0, msg.length, port, upstream, () => {
      client.close();
    });
  }

  async setSystemDNS() {
    if (this.originalDNS === null) {
      this.originalDNS = await this.getSystemDNS();
    }

    const newDNS = `127.0.0.1:${this.config.port}`;
    return await this.updateSystemDNS(newDNS);
  }

  async restoreSystemDNS() {
    if (this.originalDNS !== null) {
      return await this.updateSystemDNS(this.originalDNS);
    }
    return true;
  }

  async getSystemDNS() {
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        const output = execSync('wmic nicconfig get dnservers', { encoding: 'utf-8' });
        // Parse Windows DNS output
        return '8.8.8.8'; // Default fallback
      } else if (platform === 'darwin') {
        const output = execSync('scutil --dns', { encoding: 'utf-8' });
        // Parse macOS DNS output
        return '8.8.8.8'; // Default fallback
      } else if (platform === 'linux') {
        const output = execSync('cat /etc/resolv.conf', { encoding: 'utf-8' });
        // Parse Linux DNS output
        return '8.8.8.8'; // Default fallback
      }
    } catch (err) {
      console.error('Error getting system DNS:', err);
      return '8.8.8.8';
    }
  }

  async updateSystemDNS(dnsServer) {
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        // Windows: Use netsh to set DNS
        execSync(`netsh interface ip set dns "Ethernet" static ${dnsServer.split(':')[0]}`, { stdio: 'ignore' });
        return true;
      } else if (platform === 'darwin') {
        // macOS: Use networksetup to set DNS
        execSync(`networksetup -setdnsservers Wi-Fi ${dnsServer.split(':')[0]}`, { stdio: 'ignore' });
        return true;
      } else if (platform === 'linux') {
        // Linux: Update /etc/resolv.conf (requires sudo)
        execSync(`echo "nameserver ${dnsServer.split(':')[0]}" | sudo tee /etc/resolv.conf`, { stdio: 'ignore' });
        return true;
      }
    } catch (err) {
      console.error('Error updating system DNS:', err);
      return false;
    }
  }
}

// ============================================================================
// DNS CATEGORY ENFORCEMENT ENGINE
// ============================================================================

class DNSCategoryEnforcer {
  static async activate(workspaceId) {
    const data = DataStore.read();
    const workspace = data.workspaces.find((w) => w.id === workspaceId);

    if (!workspace || !workspace.dnsCategories || workspace.dnsCategories.length === 0) {
      return true; // No DNS categories to enforce
    }

    console.log(`[DNS] Activating DNS categories for workspace: ${workspace.name}`);
    console.log(`[DNS] Categories: ${workspace.dnsCategories.join(', ')}`);

    const dnsService = new DNSService();

    // Start local DNS server
    await dnsService.startLocalDNSServer();

    // Set system DNS to our local server
    await dnsService.setSystemDNS();

    // Enable categories on external provider
    const success = await dnsService.enableCategories(workspace.dnsCategories);

    if (success) {
      console.log(`[DNS] Successfully activated categories: ${workspace.dnsCategories.join(', ')}`);
      return true;
    } else {
      console.error('[DNS] Failed to activate DNS categories');
      return false;
    }
  }

  static async deactivate(workspaceId) {
    const data = DataStore.read();
    const workspace = data.workspaces.find((w) => w.id === workspaceId);

    if (!workspace || !workspace.dnsCategories || workspace.dnsCategories.length === 0) {
      return true; // No DNS categories to deactivate
    }

    console.log(`[DNS] Deactivating DNS categories for workspace: ${workspace.name}`);

    const dnsService = new DNSService();

    // Disable categories on external provider
    await dnsService.disableCategories(workspace.dnsCategories);

    // Restore original DNS settings
    await dnsService.restoreSystemDNS();

    // Stop local DNS server
    await dnsService.stopLocalDNSServer();

    console.log('[DNS] Successfully deactivated DNS categories');
    return true;
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGINT', () => {
  // Deactivate all active workspaces
  if (activeWorkspaceId) {
    WorkspaceEnforcer.deactivate(activeWorkspaceId);
  }

  app.quit();
});

module.exports = { WorkspaceEnforcer, ProcessControl, DataStore, DNSService, DNSCategoryEnforcer };




