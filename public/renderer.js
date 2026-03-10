// ============================================================================
// STATE
// ============================================================================

let workspaces = [];
let programs = [];
let selectedWorkspaceId = null;
let activeWorkspaceId = null;
let windowTitles = [];
let frozenStates = [];
let hiddenWindowTitles = [];
let lastRunningWindowedKey = null;
let windowThumbnailMap = new Map();
let windowIconMap = new Map();
let windowThumbnailSources = [];
let lastThumbnailCount = 0;
let lastThumbnailDebug = { allCount: 0, windowCount: 0, screenCount: 0 };
let loadingThumbnails = false;
let ownWindowPid = null;
let ownBrowserPid = null;
let hostsStatus = null;
let lastThumbnailFetchAt = 0;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Renderer process initialized');
  
  // Debug: Check if labcoat API is available
  console.log('Renderer: Checking labcoat API availability');
  console.log('Renderer: window.labcoat exists:', !!window.labcoat);
  if (window.labcoat) {
    console.log('Renderer: window.labcoat structure:', {
      hasTest: typeof window.labcoat.test === 'function',
      hasWorkspace: !!window.labcoat.workspace,
      hasWorkspaceCreate: typeof window.labcoat.workspace?.create === 'function',
      hasProgram: !!window.labcoat.program,
      hasSystem: !!window.labcoat.system,
      hasDNS: !!window.labcoat.dns
    });
    // Test the simple function first
    if (typeof window.labcoat.test === 'function') {
      try {
        const testResult = window.labcoat.test();
        console.log('Renderer: Test function result:', testResult);
      } catch (err) {
        console.error('Renderer: Test function failed:', err);
      }
    }
  } else {
    console.error('Renderer: window.labcoat is not available!');
  }

  // Load initial data
  await loadSystemInfo();
  await loadHostsStatus();
  await loadWorkspaces();
  await loadPrograms();
  await loadActiveWorkspace();
  await loadRunningProcesses();
  ensureToastContainer();

  // Setup event listeners
  setupEventListeners();
  initFocusMode();

  // Setup update listeners
  if (window.labcoat) {
    window.labcoat.on('workspace:updated', () => {
      loadWorkspaces();
      loadActiveWorkspace();
    });

    window.labcoat.on('program:updated', () => {
      loadPrograms();
    });

    window.labcoat.on('program:discover:found', (payload) => {
      if (!payload?.program) return;
      const execPath = payload.program.execPath?.toLowerCase();
      if (!execPath) return;

      const alreadyFound = discoveredPrograms.some(
        (p) => p.execPath?.toLowerCase() === execPath
      );
      const alreadyInLibrary = programs.some(
        (p) => p.execPath?.toLowerCase() === execPath
      );

      if (!alreadyFound && !alreadyInLibrary) {
        discoveredPrograms.push(payload.program);
        applyDiscoveryFilter();
        updateDiscoveryStatus();
      }
    });

    window.labcoat.on('program:discover:done', () => {
      discoveryRunning = false;
      updateDiscoveryStatus();
    });

    window.labcoat.on('program:discover:error', (payload) => {
      discoveryRunning = false;
      const statusEl = document.getElementById('discoveryStatus');
      if (statusEl) {
        statusEl.textContent = `Error: ${payload?.error || 'Discovery failed'}`;
      }
    });

  }

  setInterval(() => {
    loadRunningProcesses();
  }, 3000);

});

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadSystemInfo() {
  try {
    const result = await window.labcoat.system.getInfo();
    if (result.success) {
      const info = `${result.platform} | Node ${result.nodeVersion} | App v${result.appVersion}`;
      document.getElementById('systemInfo').textContent = info;
    }
  } catch (err) {
    console.error('Failed to load system info:', err);
  }
}

async function loadHostsStatus() {
  try {
    const result = await window.labcoat.system.getHostsStatus();
    if (result.success) {
      hostsStatus = result;
    }
  } catch (err) {
    console.error('Failed to load hosts status:', err);
  }
}

async function loadWorkspaces() {
  try {
    const result = await window.labcoat.workspace.list();
    if (result.success) {
      workspaces = result.workspaces || [];
      renderWorkspaceList();
    }
  } catch (err) {
    console.error('Failed to load workspaces:', err);
  }
}

async function loadActiveWorkspace() {
  try {
    const result = await window.labcoat.workspace.getActive();
    if (result.success) {
      activeWorkspaceId = result.activeWorkspaceId || null;
    }
  } catch (err) {
    console.error('Failed to load active workspace:', err);
  }
}

async function loadPrograms() {
  try {
    const result = await window.labcoat.program.list();
    if (result.success) {
      programs = result.programs || [];
      renderProgramList();
      if (selectedWorkspaceId) {
        renderWorkspaceDetails();
      }
    }
  } catch (err) {
    console.error('Failed to load programs:', err);
  }
}

async function loadRunningProcesses() {
  try {
    const result = await window.labcoat.process.getRunning();
    if (result.success) {
      windowTitles = Array.isArray(result.windowTitles) ? result.windowTitles : [];
      hiddenWindowTitles = Array.isArray(result.hiddenWindowTitles) ? result.hiddenWindowTitles : [];
      frozenStates = Array.isArray(result.frozenStates) ? result.frozenStates : [];
      ownWindowPid = result.ownWindowPid ?? null;
      ownBrowserPid = result.ownBrowserPid ?? null;
      windowTitles = mergeWindowTitlesWithFrozen(windowTitles, frozenStates);
      refreshRunningWindowedSection();
      loadWindowThumbnails();
    }
  } catch (err) {
    console.error('Failed to load running processes:', err);
  }
}

async function loadWindowThumbnails() {
  if (!window.labcoat?.process?.getWindowThumbnails || loadingThumbnails) {
    return;
  }
  const now = Date.now();
  if (now - lastThumbnailFetchAt < 8000) {
    return;
  }
  loadingThumbnails = true;
  try {
    const result = await window.labcoat.process.getWindowThumbnails({ width: 240, height: 150 });
    if (result.success) {
      const nextThumbs = new Map();
      const nextIcons = new Map();
      const nextSources = Array.isArray(result.thumbnails) ? result.thumbnails : [];
      lastThumbnailCount = nextSources.length;
      lastThumbnailDebug = result.debug || { allCount: 0, windowCount: 0, screenCount: 0 };
      console.log('Renderer: window thumbnails returned:', lastThumbnailCount);
      (result.thumbnails || []).forEach((thumb) => {
        const key = normalizeWindowTitle(thumb?.title || '');
        const simplified = simplifyWindowTitle(thumb?.title || '');
        const nameKey = normalizeWindowTitle(thumb?.name || '');
        if (!key) return;
        if (!nextThumbs.has(key) && thumb.thumbnail) {
          nextThumbs.set(key, thumb.thumbnail);
        }
        if (simplified && !nextThumbs.has(simplified) && thumb.thumbnail) {
          nextThumbs.set(simplified, thumb.thumbnail);
        }
        if (nameKey && !nextThumbs.has(nameKey) && thumb.thumbnail) {
          nextThumbs.set(nameKey, thumb.thumbnail);
        }
        if (!nextIcons.has(key) && thumb.appIcon) {
          nextIcons.set(key, thumb.appIcon);
        }
        if (simplified && !nextIcons.has(simplified) && thumb.appIcon) {
          nextIcons.set(simplified, thumb.appIcon);
        }
        if (nameKey && !nextIcons.has(nameKey) && thumb.appIcon) {
          nextIcons.set(nameKey, thumb.appIcon);
        }
      });
      windowThumbnailMap = nextThumbs;
      windowIconMap = nextIcons;
      windowThumbnailSources = nextSources;
      updateWindowThumbnailElements();
      updateThumbnailStatus();
      lastThumbnailFetchAt = Date.now();
    }
  } catch (err) {
    console.error('Failed to load window thumbnails:', err);
  } finally {
    loadingThumbnails = false;
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  console.log('Setting up event listeners');
  
  // Workspace creation
  const createBtn = document.getElementById('createWorkspaceBtn');
  console.log('Create button element:', createBtn);
  
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      console.log('Create workspace button clicked');
      const input = document.getElementById('newWorkspaceName');
      const name = input.value.trim();

      console.log('Workspace name:', name);

      if (!name) {
        showToast('Please enter a workspace name');
        return;
      }

      try {
        console.log('Calling workspace.create with name:', name);
        const result = await window.labcoat.workspace.create(name);
        console.log('Workspace creation result:', result);
        
        if (result.success) {
          input.value = '';
          await loadWorkspaces();
          console.log('Workspace created successfully');
        } else {
          showToast(`Error: ${result.error}`);
        }
      } catch (error) {
        console.error('Error creating workspace:', error);
        showToast(`Error: ${error.message}`);
      }
    });
  }

  // Program creation
  document.getElementById('createProgramBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('newProgramName');
    const pathInput = document.getElementById('newProgramPath');

    const name = nameInput.value.trim();
    const execPath = pathInput.value.trim();

    if (!name || !execPath) {
      showToast('Please enter program name and path');
      return;
    }

    const result = await window.labcoat.program.create(name, execPath, []);
    if (result.success) {
      nameInput.value = '';
      pathInput.value = '';
      await loadPrograms();
    } else {
      showToast(`Error: ${result.error}`);
    }
  });

  // Program discovery
  document.getElementById('discoverProgramBtn').addEventListener('click', () => {
    openDiscoveryModal();
  });

  // Enter key support
  document.getElementById('newWorkspaceName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('createWorkspaceBtn').click();
    }
  });

  document.getElementById('newProgramPath').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('createProgramBtn').click();
    }
  });

  const focusToggle = document.getElementById('focusToggle');
  if (focusToggle) {
    focusToggle.addEventListener('click', () => {
      const nextState = !document.body.classList.contains('focus-mode');
      setFocusMode(nextState);
    });
  }
}

// ============================================================================
// RENDERING
// ============================================================================

function renderWorkspaceList() {
  const container = document.getElementById('workspaceList');

  if (workspaces.length === 0) {
    container.innerHTML = '<p class="empty-state">No workspaces yet</p>';
    document.getElementById('workspaceDetails').innerHTML =
      '<p class="empty-state">Select a workspace to configure</p>';
    return;
  }

  container.innerHTML = workspaces
    .map(
      (ws) => `
    <div class="list-item ${selectedWorkspaceId === ws.id ? 'active' : ''}" data-ws-id="${ws.id}">
      <div class="list-item-header">
        <span class="list-item-name">${escapeHtml(ws.name)}</span>
        <span class="list-item-badge ${ws.status === 'active' ? 'badge-active' : 'badge-inactive'}">
          ${ws.status}
        </span>
      </div>
      <div class="list-item-description">
        Programs: ${(ws.blocked?.length || 0) + (ws.protected?.length || 0) + (ws.autoLaunch?.length || 0) + (ws.frozenProcesses?.length || 0)}
        · Hosts: ${ws.hostBlocklist?.length || 0}
      </div>
      <div class="list-item-actions">
        ${
          ws.status === 'active'
            ? `<button class="btn btn-sm btn-danger" onclick="deactivateWorkspace('${ws.id}')">Deactivate</button>`
            : `<button class="btn btn-sm btn-success" onclick="activateWorkspace('${ws.id}')">Activate</button>`
        }
        <button class="btn btn-sm btn-danger" onclick="deleteWorkspace('${ws.id}')">Delete</button>
      </div>
    </div>
  `
    )
    .join('');

  // Add click handlers to select workspace
  container.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#workspaceList .list-item').forEach((item) => {
        item.classList.remove('active');
      });
      el.classList.add('active');
      selectedWorkspaceId = el.dataset.wsId;
      renderWorkspaceDetails();
    });
  });
}

function renderProgramList() {
  const container = document.getElementById('programList');

  if (programs.length === 0) {
    container.innerHTML = '<p class="empty-state">No programs yet</p>';
    return;
  }

  container.innerHTML = programs
    .map(
      (prog) => `
    <div class="list-item" data-prog-id="${prog.id}">
      <div class="list-item-header">
        <span class="list-item-name">${escapeHtml(prog.name)}</span>
      </div>
      <div class="list-item-actions">
        <button class="btn btn-sm btn-danger" onclick="deleteProgram('${prog.id}')">Delete</button>
      </div>
    </div>
  `
    )
    .join('');
}

async function renderWorkspaceDetails() {
  const workspace = workspaces.find((ws) => ws.id === selectedWorkspaceId);

  if (!workspace) {
    document.getElementById('workspaceDetails').innerHTML =
      '<p class="empty-state">Select a workspace to configure</p>';
    return;
  }

  const blockedPrograms = (workspace.blocked || [])
    .map((id) => programs.find((p) => p.id === id))
    .filter(Boolean);

  const protectedPrograms = (workspace.protected || [])
    .map((id) => programs.find((p) => p.id === id))
    .filter(Boolean);

  const autoLaunchPrograms = (workspace.autoLaunch || [])
    .map((id) => programs.find((p) => p.id === id))
    .filter(Boolean);

  const assignedProgramIds = new Set([
    ...blockedPrograms.map((p) => p.id),
    ...protectedPrograms.map((p) => p.id),
    ...autoLaunchPrograms.map((p) => p.id),
  ]);

  const availablePrograms = programs.filter((p) => !assignedProgramIds.has(p.id));
  const runningWindowedSectionHtml = buildRunningWindowedSectionHtml(workspace);
  const hostsWriteable = hostsStatus?.canWrite === true;
  const hostsEditable = hostsWriteable;
  const hostsDisabledAttr = hostsEditable ? '' : 'disabled';
  const hostsDisabledTitle = !hostsWriteable
    ? 'Hosts file is not writable. Run LabCoat as Administrator.'
    : '';

  const html = `
    <div class="workspace-header">
      <h3>${escapeHtml(workspace.name)}</h3>
      <div class="workspace-status">
        Status: <strong>${workspace.status === 'active' ? ' Active' : ' Inactive'}</strong>
      </div>
    </div>

    <!-- DNS CATEGORY BLOCKING -->
    <div class="rule-section">
      <h4>DNS Category Blocking</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        Block entire categories of websites using DNS-level filtering. Requires DNS provider configuration.
      </p>
      ${
        workspace.dnsCategories && workspace.dnsCategories.length > 0
          ? `
        <div class="rule-list">
          ${workspace.dnsCategories
            .map(
              (categoryId) => `
            <div class="rule-item">
              <span class="rule-item-name">${escapeHtml(getCategoryName(categoryId))}</span>
              <div class="rule-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeDNSTag('${workspace.id}', '${categoryId}')">
                  Remove
                </button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No DNS categories configured</div>'
      }
      <div style="margin-top: 12px;">
        <div class="dns-config-section">
          <div class="dns-config-header">
            <span>Configure DNS Provider</span>
            <button class="btn btn-sm btn-secondary" onclick="openDNSConfigModal()">
              Settings
            </button>
          </div>
          <div class="dns-status">
            <span id="dnsStatus">Checking connection...</span>
          </div>
        </div>
        <select id="dnsCategorySelect_${workspace.id}" class="input" style="width: 100%; margin-top: 8px;">
          <option value="">Add a DNS category...</option>
        </select>
        <button class="btn btn-primary btn-block mt-md" onclick="addDNSTag('${workspace.id}')" id="addDNSBtn" disabled>
          Add DNS Category
        </button>
      </div>
    </div>

    <!-- BLOCKED PROGRAMS -->
    <div class="rule-section">
      <h4>Blocked Programs</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        These programs will be terminated if running while this workspace is active.
      </p>
      ${
        blockedPrograms.length > 0
          ? `
        <div class="rule-list">
          ${blockedPrograms
            .map(
              (prog) => `
            <div class="rule-item">
              <span class="rule-item-name">${escapeHtml(prog.name)}</span>
              <div class="rule-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeBlockedProgram('${workspace.id}', '${prog.id}')">
                  Remove
                </button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No blocked programs</div>'
      }
      <div style="margin-top: 12px;">
        <select id="blockedSelect_${workspace.id}" class="input" style="width: 100%;">
          <option value="">Add a blocked program...</option>
          ${
            availablePrograms.length > 0
              ? availablePrograms
                  .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
                  .join('')
              : '<option value="" disabled>No available programs</option>'
          }
        </select>
        <button class="btn btn-primary btn-block mt-md" onclick="addBlockedProgram('${workspace.id}')">
          Add Blocked
        </button>
      </div>
    </div>

    <!-- PROTECTED PROGRAMS -->
    <div class="rule-section">
      <h4>Protected Programs</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        These programs will be launched and automatically relaunched if terminated while this workspace is active.
      </p>
      ${
        protectedPrograms.length > 0
          ? `
        <div class="rule-list">
          ${protectedPrograms
            .map(
              (prog) => `
            <div class="rule-item">
              <span class="rule-item-name">${escapeHtml(prog.name)}</span>
              <div class="rule-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeProtectedProgram('${workspace.id}', '${prog.id}')">
                  Remove
                </button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No protected programs</div>'
      }
      <div style="margin-top: 12px;">
        <select id="protectedSelect_${workspace.id}" class="input" style="width: 100%;">
          <option value="">Add a protected program...</option>
          ${
            availablePrograms.length > 0
              ? availablePrograms
                  .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
                  .join('')
              : '<option value="" disabled>No available programs</option>'
          }
        </select>
        <button class="btn btn-primary btn-block mt-md" onclick="addProtectedProgram('${workspace.id}')">
          Add Protected
        </button>
      </div>
    </div>

    <!-- HOSTS FILE BLOCKLIST -->
    <div class="rule-section">
      <h4>Hosts File Blocklist</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        Block domains by writing to the system hosts file (requires admin rights).
      </p>
      ${
        hostsStatus && hostsStatus.canWrite === false
          ? `
        <div class="inline-warning">
          Admin rights required to write to hosts file. Changes will not apply.
          <button class="link-button" onclick="openRunAsAdminHelp()">How to run as admin</button>
        </div>
      `
          : ''
      }
      ${
        workspace.hostBlocklist && workspace.hostBlocklist.length > 0
          ? `
        <div class="rule-list">
          ${workspace.hostBlocklist
            .map(
              (host) => `
            <div class="rule-item">
              <span class="rule-item-name">${escapeHtml(host)}</span>
              <div class="rule-item-actions">
                <button class="btn btn-sm btn-danger" ${hostsDisabledAttr} title="${hostsDisabledTitle}" onclick="removeHostBlock('${workspace.id}', '${encodeURIComponent(host)}')">
                  Remove
                </button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No blocked hosts</div>'
      }
      <div style="margin-top: 12px;">
        <input id="hostBlockInput_${workspace.id}" class="input" style="width: 100%;" placeholder="example.com" ${hostsDisabledAttr} title="${hostsDisabledTitle}" />
        <button class="btn btn-primary btn-block mt-md" ${hostsDisabledAttr} title="${hostsDisabledTitle}" onclick="addHostBlock('${workspace.id}')">
          Add Host
        </button>
      </div>
    </div>

    <!-- RUNNING WINDOWED PROCESSES -->
    <div class="rule-section" id="runningWindowedProcessesSection">
      ${runningWindowedSectionHtml}
    </div>

    <!-- AUTO-LAUNCH PROGRAMS -->
    <div class="rule-section">
      <h4>Auto-Launch Programs</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        These programs will be launched when this workspace is activated.
      </p>
      ${
        autoLaunchPrograms.length > 0
          ? `
        <div class="rule-list">
          ${autoLaunchPrograms
            .map(
              (prog) => `
            <div class="rule-item">
              <span class="rule-item-name">${escapeHtml(prog.name)}</span>
              <div class="rule-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeAutoLaunchProgram('${workspace.id}', '${prog.id}')">
                  Remove
                </button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No auto-launch programs</div>'
      }
      <div style="margin-top: 12px;">
        <select id="autoLaunchSelect_${workspace.id}" class="input" style="width: 100%;">
          <option value="">Add an auto-launch program...</option>
          ${
            availablePrograms.length > 0
              ? availablePrograms
                  .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
                  .join('')
              : '<option value="" disabled>No available programs</option>'
          }
        </select>
        <button class="btn btn-primary btn-block mt-md" onclick="addAutoLaunchProgram('${workspace.id}')">
          Add Auto-Launch
        </button>
      </div>
    </div>

  `;

  document.getElementById('workspaceDetails').innerHTML = html;
  lastRunningWindowedKey = computeRunningWindowedKey(workspace);
  
  // Load DNS categories after rendering
  loadDNSCategories(workspace.id);
}

// ============================================================================
// WORKSPACE ACTIONS
// ============================================================================

async function activateWorkspace(id) {
  const result = await window.labcoat.workspace.activate(id);
  if (result.success) {
    // Reload workspaces to get updated status
    await loadWorkspaces();
    renderWorkspaceList();
    if (selectedWorkspaceId === id) {
      renderWorkspaceDetails();
    }
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function deactivateWorkspace(id) {
  const result = await window.labcoat.workspace.deactivate(id);
  if (result.success) {
    // Reload workspaces to get updated status
    await loadWorkspaces();
    renderWorkspaceList();
    if (selectedWorkspaceId === id) {
      renderWorkspaceDetails();
    }
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function deleteWorkspace(id) {
  if (confirm('Are you sure you want to delete this workspace?')) {
    // Clear immediately for responsiveness
    document.getElementById('workspaceDetails').innerHTML = 
      '<p class="empty-state">Select a workspace to configure</p>';
    
    const result = await window.labcoat.workspace.delete(id);
    
    if (!result.success) {
      showToast(`Error: ${result.error}`);
    }
    
    // Focus input after delete completes
    setTimeout(() => {
      document.getElementById('newWorkspaceName').focus();
    }, 50);
  }
}

// ============================================================================
// PROGRAM ACTIONS
// ============================================================================

async function deleteProgram(id) {
  if (confirm('Are you sure you want to delete this program?')) {
    const result = await window.labcoat.program.delete(id);
    if (!result.success) {
      showToast(`Error: ${result.error}`);
    }
  }
}

// ============================================================================
// WORKSPACE-PROGRAM ASSOCIATION
// ============================================================================

async function addBlockedProgram(workspaceId) {
  const select = document.getElementById(`blockedSelect_${workspaceId}`);
  const programId = select.value;

  if (!programId) {
    showToast('Please select a program');
    return;
  }

  const result = await window.labcoat.workspace.addBlocked(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function removeBlockedProgram(workspaceId, programId) {
  const result = await window.labcoat.workspace.removeBlocked(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function addProtectedProgram(workspaceId) {
  const select = document.getElementById(`protectedSelect_${workspaceId}`);
  const programId = select.value;

  if (!programId) {
    showToast('Please select a program');
    return;
  }

  const result = await window.labcoat.workspace.addProtected(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function removeProtectedProgram(workspaceId, programId) {
  const result = await window.labcoat.workspace.removeProtected(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function addAutoLaunchProgram(workspaceId) {
  const select = document.getElementById(`autoLaunchSelect_${workspaceId}`);
  const programId = select.value;

  if (!programId) {
    showToast('Please select a program');
    return;
  }

  const result = await window.labcoat.workspace.addAutoLaunch(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function removeAutoLaunchProgram(workspaceId, programId) {
  const result = await window.labcoat.workspace.removeAutoLaunch(workspaceId, programId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
    await loadRunningProcesses();
  ensureToastContainer();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function toggleFrozenProcess(workspaceId, encodedName, encodedTitle, enabled) {
  const name = decodeURIComponent(encodedName || '');
  const title = decodeURIComponent(encodedTitle || '');

  if (!title) {
    showToast('Invalid process title');
    return;
  }

  if (enabled) {
    const combined = `${name} ${title}`.toLowerCase();
    const isUnsafe = UNSAFE_KEYWORDS.some((k) => combined.includes(k));
    if (isUnsafe) {
      const ok = confirm(
        'Warning: This app is known to risk unsaved work when frozen or throttled. Continue?'
      );
      if (!ok) {
        return;
      }
    }
  }

  const result = await window.labcoat.workspace.toggleFrozenProcess(
    workspaceId,
    name,
    title,
    enabled
  );

  if (result.success) {
    await loadWorkspaces();
    await loadRunningProcesses();
  ensureToastContainer();
    refreshRunningWindowedSection();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function showHiddenWindow(pid, encodedName, encodedTitle) {
  const name = decodeURIComponent(encodedName || '');
  const title = decodeURIComponent(encodedTitle || '');

  const result = await window.labcoat.process.showWindow(pid, name, title);
  if (result.success) {
    await loadRunningProcesses();
  ensureToastContainer();
  } else {
    showToast(`Error: ${result.error || 'Failed to show window'}`);
  }
}


// ============================================================================
// DNS CATEGORY MANAGEMENT
// ============================================================================

const categoryNames = {
  'abuse': 'Abuse',
  'adult': 'Adult Content',
  'ads': 'Ads',
  'cryptominers': 'Cryptominers',
  'dns-rebind': 'DNS Rebind',
  'phishing': 'Phishing',
  'privacy': 'Privacy',
  'redirect': 'Redirect',
  'social': 'Social Media',
  'trackers': 'Trackers',
  'gambling': 'Gambling',
  'malware': 'Malware',
  'fraud': 'Fraud'
};

function getCategoryName(categoryId) {
  return categoryNames[categoryId] || categoryId;
}

const UNSAFE_KEYWORDS = [
  'photoshop',
  'premiere',
  'after effects',
  'aftereffects',
  'illustrator',
  'indesign',
  'figma',
  'word',
  'excel',
  'powerpoint',
  'outlook',
  'onenote',
];

async function loadDNSCategories(workspaceId) {
  try {
    // Load DNS provider config
    const configResult = await window.labcoat.dns.getConfig();
    if (configResult.success) {
      const config = configResult.config;
      const statusEl = document.getElementById('dnsStatus');
      const addBtn = document.getElementById('addDNSBtn');
      const select = document.getElementById(`dnsCategorySelect_${workspaceId}`);
      
      if (config.provider && config.apiKey && config.profileId) {
        // Test connection
        const testResult = await window.labcoat.dns.testConnection();
        if (testResult.success) {
          statusEl.innerHTML = '<span style="color: green;">DNS provider connected</span>';
          addBtn.disabled = false;
          
          // Load available categories
          const categoriesResult = await window.labcoat.dns.getCategories();
          if (categoriesResult.success) {
            populateCategorySelect(select, categoriesResult.categories, workspaceId);
          }
        } else {
          statusEl.innerHTML = '<span style="color: red;">DNS provider connection failed</span>';
          addBtn.disabled = true;
        }
      } else {
        statusEl.innerHTML = '<span style="color: orange;">DNS provider not configured</span>';
        addBtn.disabled = true;
      }
    }
  } catch (err) {
    console.error('Error loading DNS categories:', err);
  }
}

function populateCategorySelect(select, categories, workspaceId) {
  const workspace = workspaces.find(ws => ws.id === workspaceId);
  const existingCategories = workspace.dnsCategories || [];
  
  select.innerHTML = '<option value="">Add a DNS category...</option>';
  
  categories.forEach(category => {
    if (!existingCategories.includes(category.id)) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = `${category.name} ${category.enabled ? 'âœ“' : 'âœ—'}`;
      select.appendChild(option);
    }
  });
}

async function addDNSTag(workspaceId) {
  const select = document.getElementById(`dnsCategorySelect_${workspaceId}`);
  const categoryId = select.value;

  if (!categoryId) {
    showToast('Please select a DNS category');
    return;
  }

  const result = await window.labcoat.workspace.addDNSTag(workspaceId, categoryId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

async function removeDNSTag(workspaceId, categoryId) {
  const result = await window.labcoat.workspace.removeDNSTag(workspaceId, categoryId);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    showToast(`Error: ${result.error}`);
  }
}

// ============================================================================
// HOSTS FILE BLOCKLIST
// ============================================================================

async function addHostBlock(workspaceId) {
  if (hostsStatus && hostsStatus.canWrite === false) {
    showToast('Hosts file is not writable. Run LabCoat as Administrator.', 'warning');
    return;
  }
  const input = document.getElementById(`hostBlockInput_${workspaceId}`);
  if (!input) return;
  const host = (input.value || '').trim();
  if (!host) {
    showToast('Please enter a host to block');
    return;
  }

  const result = await window.labcoat.workspace.addHostBlock(workspaceId, host);
  if (result.success) {
    input.value = '';
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    if ((result.error || '').toLowerCase().includes('not writable')) {
      await loadHostsStatus();
      renderWorkspaceDetails();
    }
    showToast(`Error: ${result.error}`);
  }
}

async function removeHostBlock(workspaceId, encodedHost) {
  if (hostsStatus && hostsStatus.canWrite === false) {
    showToast('Hosts file is not writable. Run LabCoat as Administrator.', 'warning');
    return;
  }
  const host = decodeURIComponent(encodedHost || '');
  if (!host) return;
  const result = await window.labcoat.workspace.removeHostBlock(workspaceId, host);
  if (result.success) {
    await loadWorkspaces();
    renderWorkspaceDetails();
  } else {
    if ((result.error || '').toLowerCase().includes('not writable')) {
      await loadHostsStatus();
      renderWorkspaceDetails();
    }
    showToast(`Error: ${result.error}`);
  }
}

// DNS Configuration Modal
function openDNSConfigModal() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>DNS Provider Configuration</h2>
        <button class="modal-close" onclick="this.closest('.modal').remove()">?</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Provider</label>
          <select id="dnsProvider" class="input">
            <option value="nextdns">NextDNS</option>
          </select>
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="dnsApiKey" class="input" placeholder="Enter your API key">
        </div>
        <div class="form-group">
          <label>Profile ID</label>
          <input type="text" id="dnsProfileId" class="input" placeholder="Enter your profile ID">
        </div>
        <div class="form-group">
          <label>Upstream DNS Servers</label>
          <input type="text" id="dnsUpstream" class="input" placeholder="8.8.8.8,8.8.4.4">
        </div>
        <div class="dns-test-section">
          <button class="btn btn-primary" onclick="testDNSConnection()">Test Connection</button>
          <span id="dnsTestResult" style="margin-left: 10px;"></span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="this.closest('.modal').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveDNSConfig()">Save Configuration</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Load current config
  loadDNSConfigIntoModal();
}

async function loadDNSConfigIntoModal() {
  try {
    const result = await window.labcoat.dns.getConfig();
    if (result.success) {
      const config = result.config;
      document.getElementById('dnsProvider').value = config.provider || 'nextdns';
      document.getElementById('dnsApiKey').value = config.apiKey || '';
      document.getElementById('dnsProfileId').value = config.profileId || '';
      document.getElementById('dnsUpstream').value = config.upstreamDNS?.join(',') || '8.8.8.8,8.8.4.4';
    }
  } catch (err) {
    console.error('Error loading DNS config:', err);
  }
}

async function testDNSConnection() {
  const testResultEl = document.getElementById('dnsTestResult');
  testResultEl.textContent = 'Testing...';
  testResultEl.style.color = 'orange';
  
  try {
    const result = await window.labcoat.dns.testConnection();
    if (result.success) {
      testResultEl.textContent = 'âœ“ Connection successful';
      testResultEl.style.color = 'green';
    } else {
      testResultEl.textContent = 'âœ— Connection failed';
      testResultEl.style.color = 'red';
    }
  } catch (err) {
    testResultEl.textContent = 'âœ— Error: ' + err.message;
    testResultEl.style.color = 'red';
  }
}

async function saveDNSConfig() {
  const config = {
    provider: document.getElementById('dnsProvider').value,
    apiKey: document.getElementById('dnsApiKey').value.trim(),
    profileId: document.getElementById('dnsProfileId').value.trim(),
    upstreamDNS: document.getElementById('dnsUpstream').value.split(',').map(s => s.trim())
  };
  
  const result = await window.labcoat.dns.saveConfig(config);
  if (result.success) {
    showToast('DNS configuration saved successfully!');
    document.querySelector('.modal').remove();
    // Reload DNS categories for current workspace
    if (selectedWorkspaceId) {
      loadDNSCategories(selectedWorkspaceId);
    }
  } else {
    showToast(`Error saving configuration: ${result.error}`);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function ensureToastContainer() {
  if (document.getElementById('toastContainer')) return;
  const container = document.createElement('div');
  container.id = 'toastContainer';
  container.className = 'toast-container';
  document.body.appendChild(container);
}

function showToast(message, type = 'info') {
  ensureToastContainer();
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hide');
  }, 2800);
  setTimeout(() => {
    toast.remove();
  }, 3400);
}

function initFocusMode() {
  const stored = localStorage.getItem('focusMode');
  setFocusMode(stored === '1');
}

function setFocusMode(enabled) {
  document.body.classList.toggle('focus-mode', enabled);
  const toggle = document.getElementById('focusToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.textContent = enabled ? 'Exit Focus' : 'Focus Mode';
  }
  localStorage.setItem('focusMode', enabled ? '1' : '0');
}

function openRunAsAdminHelp() {
  showToast('Right-click the app/terminal and choose Run as Administrator.', 'info');
}

function normalizeWindowTitle(title) {
  return (title || '').trim().toLowerCase();
}

function simplifyWindowTitle(title) {
  const normalized = normalizeWindowTitle(title);
  if (!normalized) return '';
  return normalized
    .replace(/\s*[-–—]\s*.+$/g, '')
    .replace(/\s*\|\s*.+$/g, '')
    .trim();
}

function getProcessKey(proc) {
  const name = (proc?.name || '').toLowerCase();
  const title = (proc?.title || '').toLowerCase();
  return `${name}|||${title}`.trim();
}

function updateWindowThumbnailElements() {
  const thumbContainers = document.querySelectorAll('.window-thumb[data-window-title]');
  thumbContainers.forEach((container) => {
    const encodedTitle = container.dataset.windowTitle || '';
    const title = decodeURIComponent(encodedTitle);
    const img = container.querySelector('.window-thumbnail');
    const fallback = container.querySelector('.window-thumb-fallback');
    const icon = container.querySelector('.window-thumb-icon');
    const encodedName = container.dataset.windowName || '';
    const name = decodeURIComponent(encodedName || '');
    const match = findThumbnailForProcess({ title, name });
    const thumbnail = match?.thumbnail;
    const iconUrl = match?.appIcon;

    if (img) {
      if (thumbnail) {
        img.src = thumbnail;
        img.classList.remove('is-empty');
      } else {
        img.removeAttribute('src');
        img.classList.add('is-empty');
      }
    }

    if (fallback) {
      fallback.style.display = thumbnail ? 'none' : 'flex';
    }

    if (icon) {
      if (iconUrl) {
        icon.src = iconUrl;
        icon.classList.remove('hidden');
      } else {
        icon.classList.add('hidden');
      }
    }
  });
  updateThumbnailStatus();
}

function updateThumbnailStatus() {
  const statusEl = document.getElementById('thumbnailStatus');
  if (!statusEl) return;
  if (!window.labcoat?.process?.getWindowThumbnails) {
    statusEl.textContent = 'Window thumbnails API not available.';
    return;
  }
  const hasCapturer = lastThumbnailDebug.hasCapturer;
  const capturerText = hasCapturer === false ? 'desktopCapturer unavailable' : 'desktopCapturer ok';
  statusEl.textContent = `Window thumbnails detected: ${lastThumbnailCount} (windows: ${lastThumbnailDebug.windowCount || 0}, screens: ${lastThumbnailDebug.screenCount || 0}) · ${capturerText}`;
}

async function logCapturerDebug() {
  if (!window.labcoat?.process?.getCapturerDebug) return;
  try {
    const result = await window.labcoat.process.getCapturerDebug();
    if (result.success) {
      console.log('Renderer: capturer debug', result);
    } else {
      console.log('Renderer: capturer debug failed', result.error);
    }
  } catch (err) {
    console.log('Renderer: capturer debug error', err);
  }
}

function findThumbnailForProcess(proc) {
  const title = normalizeWindowTitle(proc?.title || '');
  const simplified = simplifyWindowTitle(proc?.title || '');
  const name = normalizeWindowTitle(proc?.name || '');

  const tryKeys = [title, simplified].filter(Boolean);
  for (const key of tryKeys) {
    if (windowThumbnailMap.has(key) || windowIconMap.has(key)) {
      return {
        thumbnail: windowThumbnailMap.get(key),
        appIcon: windowIconMap.get(key),
      };
    }
  }

  if (windowThumbnailSources.length === 0) return null;

  const candidates = windowThumbnailSources.filter((source) => {
    const sourceTitle = normalizeWindowTitle(source?.title || '');
    const sourceSimplified = simplifyWindowTitle(source?.title || '');
    if (!sourceTitle) return false;
    if (title && (sourceTitle.includes(title) || title.includes(sourceTitle))) return true;
    if (simplified && (sourceSimplified.includes(simplified) || simplified.includes(sourceSimplified))) return true;
    if (name && (sourceTitle.includes(name) || name.includes(sourceTitle))) return true;
    return false;
  });

  const best = candidates[0] || null;
  if (!best) return null;
  return {
    thumbnail: best.thumbnail || '',
    appIcon: best.appIcon || '',
  };
}

function getWorkspaceFrozenKeySet(workspace) {
  const items = workspace?.frozenProcesses || [];
  return new Set(items.map((p) => getProcessKey(p)));
}

function mergeWindowTitlesWithFrozen(windowList, frozenList) {
  const merged = Array.isArray(windowList) ? [...windowList] : [];
  const existingKeys = new Set(merged.map((proc) => getProcessKey(proc)));
  (Array.isArray(frozenList) ? frozenList : []).forEach((state) => {
    const title = (state?.title || '').trim();
    if (!title) return;
    const proc = {
      name: state.name || '',
      title,
      pid: state.pid,
      hidden: true,
    };
    const key = getProcessKey(proc);
    if (key && !existingKeys.has(key)) {
      merged.push(proc);
      existingKeys.add(key);
    }
  });
  return merged;
}

function mergeWindowTitlesWithHidden(windowList, hiddenList) {
  const merged = Array.isArray(windowList) ? [...windowList] : [];
  const existingKeys = new Set(merged.map((proc) => getProcessKey(proc)));
  (Array.isArray(hiddenList) ? hiddenList : []).forEach((proc) => {
    const key = getProcessKey(proc);
    if (!key || existingKeys.has(key)) return;
    merged.push({
      name: proc.name || '',
      title: proc.title || '',
      pid: proc.pid,
      hidden: true,
    });
    existingKeys.add(key);
  });
  return merged;
}

function mergeConfiguredFrozenForWorkspace(windowList, workspace, frozenList) {
  const merged = Array.isArray(windowList) ? [...windowList] : [];
  const existingKeys = new Set(merged.map((proc) => getProcessKey(proc)));
  const frozenMap = new Map(
    (Array.isArray(frozenList) ? frozenList : []).map((state) => [
      getProcessKey(state),
      state,
    ])
  );

  (workspace?.frozenProcesses || []).forEach((proc) => {
    const key = getProcessKey(proc);
    if (!key || existingKeys.has(key)) return;
    const frozenState = frozenMap.get(key);
    merged.push({
      name: proc.name || '',
      title: proc.title || '',
      pid: frozenState?.pid,
      hidden: true,
    });
    existingKeys.add(key);
  });

  return merged;
}

function getRunningWindowedProcessesForWorkspace(workspace) {
  const list = mergeConfiguredFrozenForWorkspace(
    mergeWindowTitlesWithHidden(windowTitles || [], hiddenWindowTitles),
    workspace,
    frozenStates
  );
  return list.filter((proc) => !isNoiseWindow(proc));
}

function isNoiseWindow(proc) {
  if (isWindowsSystemWindow(proc)) return true;
  if (ownWindowPid && Number(proc?.pid) === Number(ownWindowPid)) return true;
  if (ownBrowserPid && Number(proc?.pid) === Number(ownBrowserPid)) return true;
  const title = (proc?.title || '').toLowerCase();
  const name = (proc?.name || '').toLowerCase();
  if (!title && !name) return true;
  if (title.includes('default ime') || title.includes('msctfime ui')) return true;
  if (name === 'applicationframehost' || name === 'textinputhost') return true;
  return false;
}

function isWindowsSystemWindow(proc) {
  const pathValue = (proc?.path || '').toLowerCase();
  if (!pathValue) return false;
  return (
    pathValue.startsWith('c:\\windows\\') ||
    pathValue.startsWith('c:\\windows\\system32') ||
    pathValue.startsWith('c:\\windows\\syswow64') ||
    pathValue.startsWith('c:\\windows\\systemapps') ||
    pathValue.startsWith('c:\\windows\\winsxs') ||
    pathValue.startsWith('c:\\windows\\servicing') ||
    pathValue.startsWith('c:\\windows\\assembly')
  );
}

function computeRunningWindowedKey(workspace) {
  if (!workspace) return '';
  const frozenKeySet = getWorkspaceFrozenKeySet(workspace);
  const list = getRunningWindowedProcessesForWorkspace(workspace).map((proc) => ({
    name: (proc.name || '').toLowerCase(),
    title: (proc.title || '').toLowerCase(),
    pid: proc.pid || 0,
    hidden: !!proc.hidden,
    checked: frozenKeySet.has(getProcessKey(proc)),
    badge: getFrozenModeBadge(proc) || '',
  }));
  list.sort((a, b) => {
    const aKey = `${a.title}::${a.name}::${a.pid}`;
    const bKey = `${b.title}::${b.name}::${b.pid}`;
    return aKey.localeCompare(bKey);
  });
  return JSON.stringify(list);
}

function buildRunningWindowedSectionHtml(workspace) {
  const frozenKeySet = getWorkspaceFrozenKeySet(workspace);
  const runningWindowedProcesses = getRunningWindowedProcessesForWorkspace(workspace);
  return `
      <h4>Running Windowed Processes</h4>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">
        All running processes with window titles appear here automatically. Toggle to freeze/unfreeze.
      </p>
      <p id="thumbnailStatus" style="font-size: 11px; color: #888; margin-bottom: 12px;"></p>
      ${
        runningWindowedProcesses.length > 0
          ? `
        <div class="rule-list">
          ${runningWindowedProcesses
            .map((proc) => {
              const key = getProcessKey(proc);
              const checked = frozenKeySet.has(key) ? 'checked' : '';
              const encodedName = encodeURIComponent(proc.name || '');
              const encodedTitle = encodeURIComponent(proc.title || '');
              const badgeInfo = getFrozenModeBadgeInfo(proc);
              const badgeHtml = badgeInfo
                ? `<span class="list-item-badge ${badgeInfo.className}">${escapeHtml(badgeInfo.label)}</span>`
                : '';
              return `
            <div class="rule-item rule-item-window">
              <div class="window-thumb" data-window-title="${encodedTitle}" data-window-name="${encodedName}">
                <img class="window-thumbnail is-empty" />
                <div class="window-thumb-fallback">
                  <img class="window-thumb-icon hidden" alt="" />
                  <span>Preview unavailable</span>
                </div>
              </div>
              <div class="window-details">
                <div class="window-title-row">
                  <span class="rule-item-name">${escapeHtml(proc.title || 'Untitled')}</span>
                  ${badgeHtml}${proc.hidden ? '<span class="list-item-badge badge-hidden">Hidden</span>' : ''}
                </div>
                <div class="window-meta text-muted">
                  ${escapeHtml(proc.name || 'Unknown')}${proc.pid ? ` · PID ${escapeHtml(String(proc.pid))}` : ''}
                </div>
              </div>
              <div class="window-actions">
                <label class="toggle">
                  <input type="checkbox" ${checked} onchange="toggleFrozenProcess('${workspace.id}', '${encodedName}', '${encodedTitle}', this.checked)" />
                  <span class="toggle-track"></span>
                  <span class="toggle-label">Freeze</span>
                </label>
                ${
                  proc.hidden && (proc.pid || (proc.title || '').trim())
                    ? `<button class="btn btn-sm btn-secondary" onclick="showHiddenWindow(${proc.pid ?? 'null'}, '${encodeURIComponent(proc.name || '')}', '${encodeURIComponent(proc.title || '')}')">
                        Show window
                      </button>`
                    : ''
                }
              </div>
            </div>
          `;
            })
            .join('')}
        </div>
      `
          : '<div class="empty-rules">No windowed processes detected</div>'
      }
  `;
}

function refreshRunningWindowedSection() {
  if (!selectedWorkspaceId) return;
  const workspace = workspaces.find((ws) => ws.id === selectedWorkspaceId);
  if (!workspace) return;
  const container = document.getElementById('runningWindowedProcessesSection');
  if (!container) return;
  const nextKey = computeRunningWindowedKey(workspace);
  if (nextKey === lastRunningWindowedKey) return;
  container.innerHTML = buildRunningWindowedSectionHtml(workspace);
  lastRunningWindowedKey = nextKey;
  updateWindowThumbnailElements();
}

function getFrozenModeBadge(proc) {
  const title = (proc?.title || '').toLowerCase();
  const name = (proc?.name || '').toLowerCase();
  const match = frozenStates.find((s) => {
    const sTitle = (s.title || '').toLowerCase();
    const sName = (s.name || '').toLowerCase();
    return sTitle === title && sName === name;
  });
  if (!match) return '';
  return match.mode === 'cdp' ? 'Paused via CDP' : 'Throttled';
}

function getFrozenModeBadgeInfo(proc) {
  const label = getFrozenModeBadge(proc);
  if (!label) return null;
  return {
    label,
    className: label === 'Paused via CDP' ? 'badge-cdp' : 'badge-throttle',
  };
}

// ============================================================================
// PROGRAM DISCOVERY
// ============================================================================

let discoveredPrograms = [];
let filteredPrograms = [];
let discoveryRunning = false;
let discoverySearchBound = false;

async function openDiscoveryModal() {
  const modal = document.getElementById('discoveryModal');
  modal.classList.remove('hidden');

  // Start discovery
  discoverPrograms();

  // Setup search
  const searchInput = document.getElementById('discoverySearch');
  searchInput.value = '';
  if (!discoverySearchBound) {
    searchInput.addEventListener('input', debounceSearch);
    discoverySearchBound = true;
  }
}

function closeDiscoveryModal() {
  const modal = document.getElementById('discoveryModal');
  modal.classList.add('hidden');
  // Keep discovered list in memory until app terminates
}

async function discoverPrograms() {
  const statusEl = document.getElementById('discoveryStatus');
  const listEl = document.getElementById('discoveryList');

  statusEl.textContent = 'Starting discovery...';
  listEl.innerHTML = '<p class="empty-state">Scanning...</p>';

  try {
    const result = await window.labcoat.program.discover();

    if (result.success) {
      if (Array.isArray(result.programs)) {
        discoveredPrograms = result.programs;
      }
      discoveryRunning = result.status === 'running';
      updateDiscoveryStatus();
      applyDiscoveryFilter();

      if (discoveredPrograms.length === 0 && !discoveryRunning) {
        listEl.innerHTML =
          '<p class="empty-state">All discovered programs are already in your library</p>';
      }
    } else {
      statusEl.textContent = `Error: ${result.error}`;
      listEl.innerHTML = `<p class="empty-state">${escapeHtml(result.error)}</p>`;
    }
  } catch (error) {
    console.error('Error during program discovery:', error);
    statusEl.textContent = `Error: ${error.message || 'Failed to discover programs'}`;
    listEl.innerHTML = `<p class="empty-state">${escapeHtml(error.message || 'Failed to discover programs')}</p>`;
  }
}

function renderDiscoveryList(programs) {
  const listEl = document.getElementById('discoveryList');

  if (programs.length === 0) {
    listEl.innerHTML =
      '<p class="empty-state">No programs match your search</p>';
    return;
  }

  listEl.innerHTML = programs
    .map(
      (prog, idx) => `
    <div class="discovery-item" data-idx="${idx}">
      <div class="discovery-item-name">${escapeHtml(prog.name)}</div>
      <div class="discovery-item-path">${escapeHtml(prog.execPath)}</div>
      <div class="discovery-item-actions">
        <button class="btn btn-sm btn-primary" onclick="addDiscoveredToLibrary(${idx})">
          Add to Library
        </button>
      </div>
    </div>
  `
    )
    .join('');
}

function debounceSearch() {
  applyDiscoveryFilter();
}

function applyDiscoveryFilter() {
  const searchInput = document.getElementById('discoverySearch');
  if (!searchInput) {
    filteredPrograms = discoveredPrograms;
    renderDiscoveryList(filteredPrograms);
    return;
  }
  const query = searchInput.value.toLowerCase();

  filteredPrograms = discoveredPrograms.filter((prog) => {
    return (
      prog.name.toLowerCase().includes(query) ||
      prog.execPath.toLowerCase().includes(query)
    );
  });

  renderDiscoveryList(filteredPrograms);
}

function updateDiscoveryStatus() {
  const statusEl = document.getElementById('discoveryStatus');
  if (!statusEl) return;
  const count = discoveredPrograms.length;
  if (discoveryRunning) {
    statusEl.textContent = `Discovering... Found ${count} program(s)`;
  } else {
    statusEl.textContent = count === 0 ? 'No new programs found' : `Found ${count} program(s)`;
  }
}

async function addDiscoveredToLibrary(idx) {
  const prog = filteredPrograms[idx];
  if (!prog) return;

  const result = await window.labcoat.program.addDiscovered(prog.name, prog.execPath);

  if (result.success) {
    // Remove from list
    discoveredPrograms = discoveredPrograms.filter((p) => p.execPath !== prog.execPath);
    applyDiscoveryFilter();
    updateDiscoveryStatus();
    await loadPrograms();

    if (discoveredPrograms.length === 0) {
      document.getElementById('discoveryStatus').textContent =
        'All programs added!';
    }
  } else {
    showToast(`Error: ${result.error}`);
  }
}


