const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');
let desktopCapturerRef = desktopCapturer;
if (!desktopCapturerRef?.getSources) {
  try {
    const rendererElectron = require('electron/renderer');
    desktopCapturerRef = rendererElectron.desktopCapturer || desktopCapturerRef;
  } catch (err) {
    desktopCapturerRef = desktopCapturerRef || null;
  }
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

function isValidString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidId(value) {
  return typeof value === 'string' && /^[\w-]+_\d+$/.test(value);
}

// ============================================================================
// SAFE IPC API FOR RENDERER
// ============================================================================

const api = {
  // ---- Workspace API ----

  workspace: {
    /**
     * List all workspaces
     */
    list: async () => {
      try {
        return await ipcRenderer.invoke('workspace:list');
      } catch (err) {
        console.error('Failed to list workspaces:', err);
        return { success: false, error: 'Failed to list workspaces' };
      }
    },

    /**
     * Create a new workspace
     * @param {string} name - Workspace name
     */
    create: async (name) => {
      if (!isValidString(name)) {
        return { success: false, error: 'Invalid workspace name' };
      }

      try {
        return await ipcRenderer.invoke('workspace:create', { name });
      } catch (err) {
        console.error('Failed to create workspace:', err);
        return { success: false, error: 'Failed to create workspace' };
      }
    },

    /**
     * Activate a workspace
     * @param {string} id - Workspace ID
     */
    activate: async (id) => {
      if (!isValidId(id)) {
        return { success: false, error: 'Invalid workspace ID' };
      }

      try {
        return await ipcRenderer.invoke('workspace:activate', { id });
      } catch (err) {
        console.error('Failed to activate workspace:', err);
        return { success: false, error: 'Failed to activate workspace' };
      }
    },

    /**
     * Deactivate a workspace
     * @param {string} id - Workspace ID
     */
    deactivate: async (id) => {
      if (!isValidId(id)) {
        return { success: false, error: 'Invalid workspace ID' };
      }

      try {
        return await ipcRenderer.invoke('workspace:deactivate', { id });
      } catch (err) {
        console.error('Failed to deactivate workspace:', err);
        return { success: false, error: 'Failed to deactivate workspace' };
      }
    },

    /**
     * Delete a workspace
     * @param {string} id - Workspace ID
     */
    delete: async (id) => {
      if (!isValidId(id)) {
        return { success: false, error: 'Invalid workspace ID' };
      }

      try {
        return await ipcRenderer.invoke('workspace:delete', { id });
      } catch (err) {
        console.error('Failed to delete workspace:', err);
        return { success: false, error: 'Failed to delete workspace' };
      }
    },

    /**
     * Get the currently active workspace
     */
    getActive: async () => {
      try {
        return await ipcRenderer.invoke('workspace:getActive');
      } catch (err) {
        console.error('Failed to get active workspace:', err);
        return { success: false, error: 'Failed to get active workspace' };
      }
    },

    /**
     * Add a blocked program to a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    addBlocked: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:addBlocked', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to add blocked program:', err);
        return { success: false, error: 'Failed to add blocked program' };
      }
    },

    /**
     * Remove a blocked program from a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    removeBlocked: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:removeBlocked', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to remove blocked program:', err);
        return { success: false, error: 'Failed to remove blocked program' };
      }
    },

    /**
     * Add a protected program to a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    addProtected: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:addProtected', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to add protected program:', err);
        return { success: false, error: 'Failed to add protected program' };
      }
    },

    /**
     * Remove a protected program from a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    removeProtected: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:removeProtected', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to remove protected program:', err);
        return { success: false, error: 'Failed to remove protected program' };
      }
    },

    /**
     * Add an autoLaunch program to a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    addAutoLaunch: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:addAutoLaunch', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to add autoLaunch program:', err);
        return { success: false, error: 'Failed to add autoLaunch program' };
      }
    },

    /**
     * Remove an autoLaunch program from a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} programId - Program ID
     */
    removeAutoLaunch: async (workspaceId, programId) => {
      if (!isValidId(workspaceId) || !isValidId(programId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:removeAutoLaunch', {
          workspaceId,
          programId,
        });
      } catch (err) {
        console.error('Failed to remove autoLaunch program:', err);
        return { success: false, error: 'Failed to remove autoLaunch program' };
      }
    },

    /**
     * Toggle a frozen process for a workspace (by window title/name)
     * @param {string} workspaceId - Workspace ID
     * @param {string} name - Process name
     * @param {string} title - Window title
     * @param {boolean} enabled - Whether to freeze
     */
    toggleFrozenProcess: async (workspaceId, name, title, enabled) => {
      if (!isValidId(workspaceId) || typeof enabled !== 'boolean') {
        return { success: false, error: 'Invalid workspace or toggle' };
      }
      if (!isValidString(title)) {
        return { success: false, error: 'Invalid process title' };
      }

      try {
        return await ipcRenderer.invoke('workspace:toggleFrozenProcess', {
          workspaceId,
          name,
          title,
          enabled,
        });
      } catch (err) {
        console.error('Failed to toggle frozen process:', err);
        return { success: false, error: 'Failed to toggle frozen process' };
      }
    },

    addHostBlock: async (workspaceId, host) => {
      if (!isValidId(workspaceId) || !isValidString(host)) {
        return { success: false, error: 'Invalid IDs' };
      }
      try {
        return await ipcRenderer.invoke('workspace:addHostBlock', {
          workspaceId,
          host,
        });
      } catch (err) {
        console.error('Failed to add host block:', err);
        return { success: false, error: 'Failed to add host block' };
      }
    },

    removeHostBlock: async (workspaceId, host) => {
      if (!isValidId(workspaceId) || !isValidString(host)) {
        return { success: false, error: 'Invalid IDs' };
      }
      try {
        return await ipcRenderer.invoke('workspace:removeHostBlock', {
          workspaceId,
          host,
        });
      } catch (err) {
        console.error('Failed to remove host block:', err);
        return { success: false, error: 'Failed to remove host block' };
      }
    },

  },

  // ---- Program API ----

  program: {
    /**
     * List all programs
     */
    list: async () => {
      try {
        return await ipcRenderer.invoke('program:list');
      } catch (err) {
        console.error('Failed to list programs:', err);
        return { success: false, error: 'Failed to list programs' };
      }
    },

    /**
     * Create a new program
     * @param {string} name - Program name
     * @param {string} execPath - Executable path
     * @param {string[]} args - Optional command-line arguments
     */
    create: async (name, execPath, args = []) => {
      if (!isValidString(name) || !isValidString(execPath)) {
        return { success: false, error: 'Invalid program data' };
      }

      if (!Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an array' };
      }

      try {
        return await ipcRenderer.invoke('program:create', {
          name,
          execPath,
          args,
        });
      } catch (err) {
        console.error('Failed to create program:', err);
        return { success: false, error: 'Failed to create program' };
      }
    },

    /**
     * Discover installed programs on the system
     */
    discover: async () => {
      try {
        return await ipcRenderer.invoke('program:discover');
      } catch (err) {
        console.error('Failed to discover programs:', err);
        return { success: false, error: 'Failed to discover programs', programs: [] };
      }
    },


    /**
     * Delete a program
     * @param {string} id - Program ID
     */
    delete: async (id) => {
      if (!isValidId(id)) {
        return { success: false, error: 'Invalid program ID' };
      }

      try {
        return await ipcRenderer.invoke('program:delete', { id });
      } catch (err) {
        console.error('Failed to delete program:', err);
        return { success: false, error: 'Failed to delete program' };
      }
    },

    /**
     * Add a discovered program to the system
     * @param {string} name - Program name
     * @param {string} execPath - Executable path
     * @param {string} workspaceId - Optional workspace ID
     * @param {string} ruleType - Optional rule type (blocked/protected/autoLaunch)
     */
    addDiscovered: async (name, execPath, workspaceId = null, ruleType = null) => {
      if (!isValidString(name) || !isValidString(execPath)) {
        return { success: false, error: 'Invalid program data' };
      }

      try {
        const payload = { name, execPath };
        if (workspaceId && isValidId(workspaceId) && ruleType) {
          payload.workspaceId = workspaceId;
          payload.ruleType = ruleType;
        }
        return await ipcRenderer.invoke('program:addDiscovered', payload);
      } catch (err) {
        console.error('Failed to add discovered program:', err);
        return { success: false, error: 'Failed to add program' };
      }
    },
  },

  // ---- System API ----

  system: {
    /**
     * Get system information
     */
    getInfo: async () => {
      try {
        return await ipcRenderer.invoke('system:getInfo');
      } catch (err) {
        console.error('Failed to get system info:', err);
        return { success: false, error: 'Failed to get system info' };
      }
    },
    /**
     * Check hosts file permissions
     */
    getHostsStatus: async () => {
      try {
        return await ipcRenderer.invoke('system:hostsStatus');
      } catch (err) {
        console.error('Failed to get hosts status:', err);
        return { success: false, error: 'Failed to get hosts status', canWrite: false };
      }
    },
  },

  // ---- Process API ----

  process: {
    /**
     * Get currently running program IDs and window titles
     */
    getRunning: async () => {
      try {
        return await ipcRenderer.invoke('process:running:list');
      } catch (err) {
        console.error('Failed to get running processes:', err);
        return { success: false, error: 'Failed to get running processes' };
      }
    },
    /**
     * Show a window for a hidden process
     * @param {number} pid
     * @param {string} name
     * @param {string} title
     */
    showWindow: async (pid, name, title) => {
      if (!pid && !isValidString(title)) {
        return { success: false, error: 'Invalid process' };
      }
      try {
        return await ipcRenderer.invoke('process:showWindow', { pid, name, title });
      } catch (err) {
        console.error('Failed to show window:', err);
        return { success: false, error: 'Failed to show window' };
      }
    },
    /**
     * Get window thumbnails for currently running windows
     * @param {{ width?: number, height?: number }} options
     */
    getWindowThumbnails: async (options = {}) => {
      try {
        const width = Math.max(64, Math.min(Number(options.width) || 240, 640));
        const height = Math.max(48, Math.min(Number(options.height) || 150, 480));
        return await ipcRenderer.invoke('process:window:thumbnails', { width, height });
      } catch (err) {
        console.error('Failed to get window thumbnails:', err);
        return {
          success: false,
          error: err?.message || 'Failed to get window thumbnails',
          thumbnails: [],
          debug: {
            hasCapturer: false,
            allCount: 0,
            windowCount: 0,
            screenCount: 0,
          },
        };
      }
    },
    /**
     * Debug helper for desktopCapturer availability
     */
    getCapturerDebug: async () => {
      try {
        const electronKeys = Object.keys(require('electron') || {});
        let rendererKeys = [];
        try {
          rendererKeys = Object.keys(require('electron/renderer') || {});
        } catch (err) {
          rendererKeys = [];
        }
        return {
          success: true,
          hasCapturer: !!desktopCapturerRef?.getSources,
          electronKeys,
          rendererKeys,
        };
      } catch (err) {
        return { success: false, error: err?.message || 'Debug failed' };
      }
    },
  },

  // ---- Event Listeners ----

  on: (event, callback) => {
    if (
      event === 'workspace:updated' ||
      event === 'program:updated' ||
      event === 'program:discover:found' ||
      event === 'program:discover:done' ||
      event === 'program:discover:error'
    ) {
      ipcRenderer.on(event, (_, data) => callback(data));
    } else {
      console.warn(`Unknown event: ${event}`);
    }
  },

  off: (event, callback) => {
    if (
      event === 'workspace:updated' ||
      event === 'program:updated' ||
      event === 'program:discover:found' ||
      event === 'program:discover:done' ||
      event === 'program:discover:error'
    ) {
      ipcRenderer.off(event, callback);
    }
  },
};

// ============================================================================
// DNS Provider Configuration
// ============================================================================

const dnsApi = {
  dns: {
    getConfig: async () => {
      try {
        return await ipcRenderer.invoke('dns:getConfig');
      } catch (err) {
        console.error('Failed to get DNS config:', err);
        return { success: false, error: 'Failed to get DNS config' };
      }
    },

    saveConfig: async (config) => {
      if (typeof config !== 'object' || config === null) {
        return { success: false, error: 'Invalid config' };
      }

      try {
        return await ipcRenderer.invoke('dns:saveConfig', config);
      } catch (err) {
        console.error('Failed to save DNS config:', err);
        return { success: false, error: 'Failed to save DNS config' };
      }
    },

    testConnection: async () => {
      try {
        return await ipcRenderer.invoke('dns:testConnection');
      } catch (err) {
        console.error('Failed to test DNS connection:', err);
        return { success: false, error: 'Failed to test connection' };
      }
    },

    getCategories: async () => {
      try {
        return await ipcRenderer.invoke('dns:getCategories');
      } catch (err) {
        console.error('Failed to get DNS categories:', err);
        return { success: false, error: 'Failed to get categories', categories: [] };
      }
    },
  },

  workspace: {
    addDNSTag: async (workspaceId, categoryId) => {
      if (!isValidId(workspaceId) || !isValidString(categoryId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:addDNSTag', {
          workspaceId,
          categoryId,
        });
      } catch (err) {
        console.error('Failed to add DNS category:', err);
        return { success: false, error: 'Failed to add DNS category' };
      }
    },

    removeDNSTag: async (workspaceId, categoryId) => {
      if (!isValidId(workspaceId) || !isValidString(categoryId)) {
        return { success: false, error: 'Invalid IDs' };
      }

      try {
        return await ipcRenderer.invoke('workspace:removeDNSTag', {
          workspaceId,
          categoryId,
        });
      } catch (err) {
        console.error('Failed to remove DNS category:', err);
        return { success: false, error: 'Failed to remove DNS category' };
      }
    },
  },
};

// ============================================================================
// EXPOSE API TO RENDERER
// ============================================================================

console.log('Preload: About to expose API to renderer');
console.log('Preload: API structure:', {
  hasWorkspace: !!api.workspace,
  hasWorkspaceCreate: typeof api.workspace?.create === 'function',
  hasProgram: !!api.program,
  hasSystem: !!api.system,
  hasDNS: !!dnsApi.dns,
  hasDNSWorkspace: !!dnsApi.workspace
});

// Test context bridge with a simple function first
const testApi = {
  test: () => 'Hello from preload!',
  workspace: api.workspace,
  program: api.program,
  system: api.system,
  process: api.process,
  dns: dnsApi.dns,
  on: api.on,
  off: api.off
};

contextBridge.exposeInMainWorld('labcoat', testApi);

console.log('✓ LabCoat API exposed via context bridge');
