const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let reporter = null;

function reportFound(program) {
  if (!program || !program.execPath) return;
  if (reporter) {
    reporter({ type: 'found', program });
  }
}

function _normalizeExecPath(execPath) {
  return (execPath || '').trim();
}

function _isValidExecutablePath(execPath) {
  if (!execPath) return false;
  let resolved = _normalizeExecPath(execPath);

  if (process.platform === 'win32' && resolved.toLowerCase().startsWith('shell:appsfolder\\')) {
    return true;
  }

  if (!fs.existsSync(resolved)) return false;

  if (process.platform === 'darwin') {
    return resolved.endsWith('.app') || resolved.includes('/Contents/MacOS/');
  }

  if (process.platform === 'linux') {
    return resolved.endsWith('.desktop') || fs.statSync(resolved).isFile();
  }

  if (process.platform === 'win32') {
    // Windows: only allow AppsFolder launch targets
    return false;
  }

  // Non-Windows fallback
  return fs.statSync(resolved).isFile();
}

class ProgramDiscoveryWorker {
  static async discover() {
    const platform = process.platform;
    if (platform === 'win32') {
      return await this._discoverWindows();
    }
    if (platform === 'darwin') {
      return this._discoverMacOS();
    }
    if (platform === 'linux') {
      return this._discoverLinux();
    }
    return [];
  }

  static async _discoverWindows() {
    const programs = [];

    try {
      const storeApps = this._discoverWindowsStoreApps();
      for (const program of storeApps) {
        if (!program || !program.execPath) continue;
        if (this._isSystemProgram(program.name) || this._isSystemCriticalProgram(program.name)) continue;
        programs.push(program);
        reportFound(program);
      }
    } catch (err) {
      return programs;
    }

    return programs;
  }

  static _discoverWindowsStoreApps() {
    const programs = [];
    try {
      const ps = [
        'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Depth 2'
      ].join('; ');
      const output = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      if (!output) return programs;
      let items = [];
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed) items = [parsed];
      } catch (err) {
        return programs;
      }

      for (const item of items) {
        const name = item?.Name;
        const appId = item?.AppID;
        if (!name || !appId) continue;
        const execPath = `shell:AppsFolder\\${appId}`;
        programs.push({ name, execPath, discovered: true });
      }
    } catch (err) {
      return programs;
    }
    return programs;
  }

  static _discoverMacOS() {
    const programs = [];
    const appDirs = ['/Applications', path.join(os.homedir(), 'Applications')];

    for (const appDir of appDirs) {
      if (!fs.existsSync(appDir)) continue;
      try {
        const items = fs.readdirSync(appDir);
        for (const item of items) {
          if (appDir === '/System/Applications') continue;
          if (item.startsWith('.')) continue;

          const fullPath = path.join(appDir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory() && item.endsWith('.app')) {
            const name = item.replace('.app', '');
            const execPath = path.join(fullPath, 'Contents/MacOS', name);
            if (fs.existsSync(execPath)) {
              if (this._isSystemCriticalProgram(name) || this._isSystemCriticalPath(execPath)) continue;
              if (!_isValidExecutablePath(execPath)) continue;
              const program = { name, execPath, discovered: true };
              programs.push(program);
              reportFound(program);
            }
          }
        }
      } catch (err) {
        continue;
      }
    }
    return programs;
  }

  static _discoverLinux() {
    const programs = [];
    const desktopDirs = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(os.homedir(), '.local/share/applications'),
    ];

    for (const desktopDir of desktopDirs) {
      if (!fs.existsSync(desktopDir)) continue;
      try {
        const files = fs.readdirSync(desktopDir);
        for (const file of files) {
          if (!file.endsWith('.desktop')) continue;
          const desktopPath = path.join(desktopDir, file);
          try {
            const content = fs.readFileSync(desktopPath, 'utf-8');
            let name = '';
            let exec = '';
            let noDisplay = false;

            const lines = content.split('\n');
            for (const line of lines) {
              if (line.startsWith('Name=')) name = line.substring(5).trim();
              if (line.startsWith('Exec=')) exec = line.substring(5).trim();
              if (line.startsWith('NoDisplay=true')) noDisplay = true;
            }

            if (noDisplay) continue;
            if (this._isSystemProgram(name) || this._isSystemPath(exec) ||
                this._isSystemCriticalProgram(name) || this._isSystemCriticalPath(exec)) continue;
            if (!name || !exec) continue;

            const execName = exec.split(' ')[0];
            const resolvedPath = this._resolveCommand(execName);
            if (resolvedPath && !this._isSystemCriticalPath(resolvedPath)) {
              if (!_isValidExecutablePath(resolvedPath)) continue;
              const program = { name, execPath: resolvedPath, discovered: true };
              programs.push(program);
              reportFound(program);
            }
          } catch (err) {
            continue;
          }
        }
      } catch (err) {
        continue;
      }
    }
    return programs;
  }

  static _isSystemProgram(name) {
    const systemKeywords = [
      'driver','service','windows','system','microsoft','update','installer','framework',
      '.net','runtime','redistributable','library','plugin','codec','font','background',
      'daemon','shell extension','device','firmware',
    ];
    const lowerName = (name || '').toLowerCase();
    return systemKeywords.some((keyword) => lowerName.includes(keyword));
  }

  static _isSystemCriticalProgram(name) {
    if (!name) return false;
    const criticalKeywords = [
      'kernel','security','defender','antimalware','firewall','credential','certificate',
      'cryptographic','telemetry','driver','update','service','agent','host process','system','windows',
    ];
    const lowerName = name.toLowerCase();
    return criticalKeywords.some((keyword) => lowerName.includes(keyword));
  }

  static _isSystemPath(execPath) {
    if (!execPath) return false;
    const lowerPath = execPath.toLowerCase();
    const systemPaths = [
      'c:\\windows\\system32','c:\\windows\\syswow64','c:\\windows\\system','c:\\windows\\',
      'c:\\windows\\system32\\drivers','c:\\windows\\system32\\spool','c:\\windows\\system32\\wbem',
      'c:\\windows\\system32\\config','c:\\winnt\\system32','c:\\winnt\\',
      process.env.WINDIR?.toLowerCase() + '\\system32',
      process.env.WINDIR?.toLowerCase(),
      process.env.SYSTEMROOT?.toLowerCase() + '\\system32',
      process.env.SYSTEMROOT?.toLowerCase(),
      'c:\\program files\\common files','c:\\program files (x86)\\common files',
    ];
    return systemPaths.some(systemPath => systemPath && lowerPath.startsWith(systemPath));
  }

  static _isSystemCriticalPath(execPath) {
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

  static _resolveCommand(command) {
    try {
      const result = execSync(`which "${command}"`, { encoding: 'utf-8', stdio: ['pipe','pipe','ignore'] });
      return result.trim();
    } catch (err) {
      return null;
    }
  }
}

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'start') return;
  reporter = (payload) => {
    if (process.send) process.send(payload);
  };

  try {
    const programs = await ProgramDiscoveryWorker.discover();
    if (process.send) {
      process.send({ type: 'done', programs });
    }
  } catch (err) {
    if (process.send) {
      process.send({ type: 'error', error: err.message || String(err) });
    }
  }
});
