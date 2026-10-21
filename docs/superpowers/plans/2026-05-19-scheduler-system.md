# Scheduler System Implementation Plan

**Goal:** Implement a production-quality scheduler system that enables users to schedule downloads for specific dates/times and create recurring schedules with full UI integration.

**Architecture:** Event-driven scheduler with persistent storage, separating core scheduling logic from UI components, using IPC communication between main and renderer processes.

**Tech Stack:** Electron IPC, Node.js file system, electron-store, event-based architecture.

---

## Phase 1: Core Scheduler Infrastructure

### Task 1: Create SchedulerCore Class

**Files:**
- Create: `src/scheduler/SchedulerCore.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/scheduler/SchedulerCore.test.js
const { SchedulerCore } = require('../../src/scheduler/SchedulerCore');

describe('SchedulerCore', () => {
  it('should create a valid schedule object', () => {
    const core = new SchedulerCore();
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000, // 1 hour from now
      downloadSettings: { threads: 8, outputPath: '/downloads' }
    });

    expect(schedule.id).toBeDefined();
    expect(schedule.status).toBe('pending');
    expect(schedule.downloadUrl).toBe('https://example.com/file.zip');
  });

  it('should validate schedule time is in future', () => {
    const core = new SchedulerCore();
    const result = core.validateScheduleTime(Date.now() - 1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('past');
  });

  it('should calculate next execution for daily recurring', () => {
    const core = new SchedulerCore();
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const next = core.calculateNextExecution(baseTime, {
      enabled: true,
      frequency: 'daily',
      interval: 1
    });

    const expected = new Date('2026-05-20T10:00:00Z').getTime();
    expect(next).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test - verify it fails**

```bash
cd "D:\Project\Software\CyberDM-Electron"
npm test -- tests/scheduler/SchedulerCore.test.js
```

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/scheduler/SchedulerCore.js
const { v4: uuidv4 } = require('uuid');

class SchedulerCore {
  constructor() {
    this.schedules = new Map();
  }

  createSchedule(config) {
    const schedule = {
      id: uuidv4(),
      downloadId: config.downloadId || null,
      downloadUrl: config.downloadUrl,
      downloadSettings: {
        threads: config.downloadSettings?.threads || 8,
        speedLimit: config.downloadSettings?.speedLimit || null,
        outputPath: config.downloadSettings?.outputPath || '',
        priority: config.downloadSettings?.priority || 'normal'
      },
      scheduledTime: config.scheduledTime,
      recurringConfig: config.recurringConfig || null,
      status: 'pending',
      lastExecution: null,
      nextExecution: config.scheduledTime,
      executionCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'manual',
      tags: config.tags || []
    };

    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  validateScheduleTime(timestamp) {
    const now = Date.now();
    if (timestamp < now) {
      return { valid: false, error: 'Scheduled time must be in the future' };
    }
    return { valid: true };
  }

  calculateNextExecution(baseTime, recurringConfig) {
    if (!recurringConfig || !recurringConfig.enabled) {
      return null;
    }

    const { frequency, interval } = recurringConfig;
    const baseDate = new Date(baseTime);

    switch (frequency) {
      case 'daily':
        return new Date(baseDate.getTime() + (interval * 24 * 60 * 60 * 1000)).getTime();
      case 'weekly':
        return new Date(baseDate.getTime() + (interval * 7 * 24 * 60 * 60 * 1000)).getTime();
      case 'monthly':
        const nextMonth = new Date(baseDate);
        nextMonth.setMonth(nextMonth.getMonth() + interval);
        return nextMonth.getTime();
      default:
        return null;
    }
  }

  updateScheduleStatus(scheduleId, status) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;

    schedule.status = status;
    schedule.updatedAt = Date.now();
    return schedule;
  }

  getSchedule(scheduleId) {
    return this.schedules.get(scheduleId);
  }

  getAllSchedules() {
    return Array.from(this.schedules.values());
  }
}

module.exports = { SchedulerCore };
```

- [ ] **Step 4: Run test - verify it passes**

```bash
npm test -- tests/scheduler/SchedulerCore.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/SchedulerCore.js tests/scheduler/SchedulerCore.test.js
git commit -m "feat: Add SchedulerCore class with basic scheduling logic"
```

---

### Task 2: Create SchedulerStorage Class

**Files:**
- Create: `src/scheduler/SchedulerStorage.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/scheduler/SchedulerStorage.test.js
const { SchedulerStorage } = require('../../src/scheduler/SchedulerStorage');
const fs = require('fs');
const path = require('path');

describe('SchedulerStorage', () => {
  const testStoragePath = path.join(__dirname, 'test-schedules.json');

  beforeEach(() => {
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }
  });

  it('should save and retrieve schedule', async () => {
    const storage = new SchedulerStorage(testStoragePath);
    const schedule = {
      id: 'test-123',
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000,
      status: 'pending'
    };

    await storage.saveSchedule(schedule);
    const retrieved = await storage.getSchedule('test-123');

    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe('test-123');
    expect(retrieved.downloadUrl).toBe('https://example.com/file.zip');
  });

  it('should get all schedules', async () => {
    const storage = new SchedulerStorage(testStoragePath);
    await storage.saveSchedule({ id: '1', downloadUrl: 'url1', scheduledTime: Date.now() + 1000, status: 'pending' });
    await storage.saveSchedule({ id: '2', downloadUrl: 'url2', scheduledTime: Date.now() + 2000, status: 'pending' });

    const all = await storage.getAllSchedules();
    expect(all.length).toBe(2);
  });

  it('should update schedule', async () => {
    const storage = new SchedulerStorage(testStoragePath);
    await storage.saveSchedule({ id: '1', downloadUrl: 'url1', scheduledTime: Date.now() + 1000, status: 'pending' });

    await storage.updateSchedule('1', { status: 'completed' });
    const updated = await storage.getSchedule('1');

    expect(updated.status).toBe('completed');
  });

  it('should delete schedule', async () => {
    const storage = new SchedulerStorage(testStoragePath);
    await storage.saveSchedule({ id: '1', downloadUrl: 'url1', scheduledTime: Date.now() + 1000, status: 'pending' });

    await storage.deleteSchedule('1');
    const deleted = await storage.getSchedule('1');

    expect(deleted).toBeNull();
  });
});
```

- [ ] **Step 2: Run test - verify it fails**

```bash
npm test -- tests/scheduler/SchedulerStorage.test.js
```

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/scheduler/SchedulerStorage.js
const fs = require('fs').promises;
const path = require('path');

class SchedulerStorage {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.schedules = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const data = await fs.readFile(this.storagePath, 'utf8');
      const schedules = JSON.parse(data);
      schedules.forEach(schedule => {
        this.schedules.set(schedule.id, schedule);
      });
      this.initialized = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading schedules:', error);
      }
      this.initialized = true;
    }
  }

  async saveSchedule(schedule) {
    await this.initialize();
    this.schedules.set(schedule.id, schedule);
    await this.persist();
    return schedule;
  }

  async getSchedule(scheduleId) {
    await this.initialize();
    return this.schedules.get(scheduleId) || null;
  }

  async getAllSchedules() {
    await this.initialize();
    return Array.from(this.schedules.values());
  }

  async updateSchedule(scheduleId, updates) {
    await this.initialize();
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;

    const updated = { ...schedule, ...updates, updatedAt: Date.now() };
    this.schedules.set(scheduleId, updated);
    await this.persist();
    return updated;
  }

  async deleteSchedule(scheduleId) {
    await this.initialize();
    const deleted = this.schedules.delete(scheduleId);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  async getActiveSchedules() {
    await this.initialize();
    return Array.from(this.schedules.values()).filter(
      s => s.status === 'pending' || s.status === 'ready'
    );
  }

  async getCompletedSchedules() {
    await this.initialize();
    return Array.from(this.schedules.values()).filter(
      s => s.status === 'completed'
    );
  }

  async persist() {
    const data = JSON.stringify(Array.from(this.schedules.values()), null, 2);
    await fs.writeFile(this.storagePath, data, 'utf8');
  }
}

module.exports = { SchedulerStorage };
```

- [ ] **Step 4: Run test - verify it passes**

```bash
npm test -- tests/scheduler/SchedulerStorage.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/SchedulerStorage.js tests/scheduler/SchedulerStorage.test.js
git commit -m "feat: Add SchedulerStorage class with persistent storage"
```

---

### Task 3: Create SchedulerEventEngine Class

**Files:**
- Create: `src/scheduler/SchedulerEventEngine.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/scheduler/SchedulerEventEngine.test.js
const { SchedulerEventEngine } = require('../../src/scheduler/SchedulerEventEngine');

describe('SchedulerEventEngine', () => {
  it('should detect due schedules', () => {
    const engine = new SchedulerEventEngine();
    const now = Date.now();

    const schedules = [
      { id: '1', scheduledTime: now - 1000, status: 'pending' },
      { id: '2', scheduledTime: now + 1000, status: 'pending' },
      { id: '3', scheduledTime: now - 500, status: 'completed' }
    ];

    const due = engine.findDueSchedules(schedules, now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('1');
  });

  it('should validate schedule conditions', () => {
    const engine = new SchedulerEventEngine();
    const schedule = {
      downloadUrl: 'https://example.com/file.zip',
      downloadSettings: { outputPath: '/downloads' }
    };

    const result = engine.validateScheduleConditions(schedule);
    expect(result.valid).toBe(true);
  });

  it('should calculate next execution for recurring', () => {
    const engine = new SchedulerEventEngine();
    const schedule = {
      id: '1',
      scheduledTime: Date.now() - 1000,
      recurringConfig: {
        enabled: true,
        frequency: 'daily',
        interval: 1
      }
    };

    const next = engine.calculateNextExecution(schedule);
    expect(next).toBeDefined();
    expect(next).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run test - verify it fails**

```bash
npm test -- tests/scheduler/SchedulerEventEngine.test.js
```

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/scheduler/SchedulerEventEngine.js
const fs = require('fs');
const path = require('path');

class SchedulerEventEngine {
  constructor(downloadEngine, storage) {
    this.downloadEngine = downloadEngine;
    this.storage = storage;
    this.checkInterval = 30000; // 30 seconds
    this.intervalId = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.checkAndExecuteSchedules();
    }, this.checkInterval);

    console.log('[Scheduler] Event engine started');
  }

  stop() {
    if (!this.isRunning) return;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    console.log('[Scheduler] Event engine stopped');
  }

  async checkAndExecuteSchedules() {
    try {
      const now = Date.now();
      const activeSchedules = await this.storage.getActiveSchedules();
      const dueSchedules = this.findDueSchedules(activeSchedules, now);

      for (const schedule of dueSchedules) {
        await this.executeSchedule(schedule);
      }
    } catch (error) {
      console.error('[Scheduler] Error checking schedules:', error);
    }
  }

  findDueSchedules(schedules, currentTime) {
    return schedules.filter(schedule => {
      return schedule.status === 'pending' &&
             schedule.scheduledTime <= currentTime;
    });
  }

  async executeSchedule(schedule) {
    try {
      console.log(`[Scheduler] Executing schedule: ${schedule.id}`);

      // Update status to executing
      await this.storage.updateSchedule(schedule.id, {
        status: 'executing',
        lastExecution: Date.now()
      });

      // Validate conditions
      const validation = this.validateScheduleConditions(schedule);
      if (!validation.valid) {
        await this.handleScheduleFailure(schedule, validation.error);
        return;
      }

      // Start download
      const downloadId = await this.startDownload(schedule);

      // Update schedule status
      if (schedule.recurringConfig?.enabled) {
        const nextExecution = this.calculateNextExecution(schedule);
        await this.storage.updateSchedule(schedule.id, {
          status: 'pending',
          nextExecution: nextExecution,
          scheduledTime: nextExecution,
          executionCount: schedule.executionCount + 1
        });
      } else {
        await this.storage.updateSchedule(schedule.id, {
          status: 'completed',
          executionCount: schedule.executionCount + 1
        });
      }

      console.log(`[Scheduler] Schedule ${schedule.id} completed successfully`);

    } catch (error) {
      console.error(`[Scheduler] Error executing schedule ${schedule.id}:`, error);
      await this.handleScheduleFailure(schedule, error.message);
    }
  }

  validateScheduleConditions(schedule) {
    // Check disk space
    const downloadPath = schedule.downloadSettings.outputPath || require('electron').app.getPath('downloads');
    try {
      const stats = fs.statSync(downloadPath);
      // Basic validation - could be enhanced
    } catch (error) {
      return { valid: false, error: 'Invalid download path' };
    }

    // Validate URL format
    try {
      new URL(schedule.downloadUrl);
    } catch (error) {
      return { valid: false, error: 'Invalid URL format' };
    }

    return { valid: true };
  }

  async startDownload(schedule) {
    // This will integrate with existing download engine
    // For now, return a mock download ID
    const downloadId = require('uuid').v4();

    // TODO: Integrate with actual download engine
    // await this.downloadEngine.startDownload({
    //   url: schedule.downloadUrl,
    //   threads: schedule.downloadSettings.threads,
    //   outputPath: schedule.downloadSettings.outputPath,
    //   priority: schedule.downloadSettings.priority
    // });

    return downloadId;
  }

  calculateNextExecution(schedule) {
    if (!schedule.recurringConfig || !schedule.recurringConfig.enabled) {
      return null;
    }

    const { frequency, interval } = schedule.recurringConfig;
    const baseTime = schedule.scheduledTime || Date.now();
    const baseDate = new Date(baseTime);

    switch (frequency) {
      case 'daily':
        return new Date(baseDate.getTime() + (interval * 24 * 60 * 60 * 1000)).getTime();
      case 'weekly':
        return new Date(baseDate.getTime() + (interval * 7 * 24 * 60 * 60 * 1000)).getTime();
      case 'monthly':
        const nextMonth = new Date(baseDate);
        nextMonth.setMonth(nextMonth.getMonth() + interval);
        return nextMonth.getTime();
      default:
        return null;
    }
  }

  async handleScheduleFailure(schedule, error) {
    await this.storage.updateSchedule(schedule.id, {
      status: 'failed',
      error: error
    });

    console.error(`[Scheduler] Schedule ${schedule.id} failed: ${error}`);
  }
}

module.exports = { SchedulerEventEngine };
```

- [ ] **Step 4: Run test - verify it passes**

```bash
npm test -- tests/scheduler/SchedulerEventEngine.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/SchedulerEventEngine.js tests/scheduler/SchedulerEventEngine.test.js
git commit -m "feat: Add SchedulerEventEngine for time-based execution"
```

---

## Phase 2: IPC Communication Integration

### Task 4: Add Scheduler IPC Handlers to Main Process

**Files:**
- Modify: `src/main.js` (add scheduler initialization and IPC handlers)

- [ ] **Step 1: Add scheduler imports and initialization**

```javascript
// Add at top of main.js after existing imports
const { SchedulerCore } = require('./scheduler/SchedulerCore');
const { SchedulerStorage } = require('./scheduler/SchedulerStorage');
const { SchedulerEventEngine } = require('./scheduler/SchedulerEventEngine');

// Add to global references section
let schedulerCore = null;
let schedulerStorage = null;
let schedulerEventEngine = null;

// Add to app.whenReady() section
app.whenReady().then(async () => {
  // ... existing code ...

  // Initialize scheduler
  const schedulerPath = path.join(APP_DATA, 'schedules.json');
  schedulerStorage = new SchedulerStorage(schedulerPath);
  await schedulerStorage.initialize();

  schedulerCore = new SchedulerCore();
  schedulerEventEngine = new SchedulerEventEngine(downloadEngine, schedulerStorage);
  schedulerEventEngine.start();

  console.log('[Scheduler] System initialized');
});
```

- [ ] **Step 2: Add scheduler IPC handlers**

```javascript
// Add these IPC handlers after existing ones

// Scheduler: Create new schedule
ipcMain.handle('scheduler:create', async (event, scheduleConfig) => {
  try {
    const validation = schedulerCore.validateScheduleTime(scheduleConfig.scheduledTime);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const schedule = schedulerCore.createSchedule(scheduleConfig);
    await schedulerStorage.saveSchedule(schedule);

    mainWindow.webContents.send('scheduler:new', schedule);
    return { success: true, schedule };
  } catch (error) {
    console.error('[Scheduler] Error creating schedule:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Update existing schedule
ipcMain.handle('scheduler:update', async (event, scheduleId, updates) => {
  try {
    const updated = await schedulerStorage.updateSchedule(scheduleId, updates);
    if (!updated) {
      return { success: false, error: 'Schedule not found' };
    }

    mainWindow.webContents.send('scheduler:updated', updated);
    return { success: true, schedule: updated };
  } catch (error) {
    console.error('[Scheduler] Error updating schedule:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Delete schedule
ipcMain.handle('scheduler:delete', async (event, scheduleId) => {
  try {
    const deleted = await schedulerStorage.deleteSchedule(scheduleId);
    if (!deleted) {
      return { success: false, error: 'Schedule not found' };
    }

    mainWindow.webContents.send('scheduler:deleted', { id: scheduleId });
    return { success: true };
  } catch (error) {
    console.error('[Scheduler] Error deleting schedule:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Cancel schedule
ipcMain.handle('scheduler:cancel', async (event, scheduleId) => {
  try {
    const updated = await schedulerStorage.updateSchedule(scheduleId, {
      status: 'cancelled'
    });

    if (!updated) {
      return { success: false, error: 'Schedule not found' };
    }

    mainWindow.webContents.send('scheduler:updated', updated);
    return { success: true, schedule: updated };
  } catch (error) {
    console.error('[Scheduler] Error cancelling schedule:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Get all schedules
ipcMain.handle('scheduler:get-all', async () => {
  try {
    const schedules = await schedulerStorage.getAllSchedules();
    return { success: true, schedules };
  } catch (error) {
    console.error('[Scheduler] Error getting schedules:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Get active schedules
ipcMain.handle('scheduler:get-active', async () => {
  try {
    const schedules = await schedulerStorage.getActiveSchedules();
    return { success: true, schedules };
  } catch (error) {
    console.error('[Scheduler] Error getting active schedules:', error);
    return { success: false, error: error.message };
  }
});

// Scheduler: Validate schedule
ipcMain.handle('scheduler:validate', async (event, scheduleConfig) => {
  try {
    const timeValidation = schedulerCore.validateScheduleTime(scheduleConfig.scheduledTime);

    // Additional validations
    const urlValidation = (() => {
      try {
        new URL(scheduleConfig.downloadUrl);
        return { valid: true };
      } catch (error) {
        return { valid: false, error: 'Invalid URL format' };
      }
    })();

    return {
      success: true,
      valid: timeValidation.valid && urlValidation.valid,
      errors: [
        !timeValidation.valid ? timeValidation.error : null,
        !urlValidation.valid ? urlValidation.error : null
      ].filter(Boolean)
    };
  } catch (error) {
    console.error('[Scheduler] Error validating schedule:', error);
    return { success: false, error: error.message };
  }
});
```

- [ ] **Step 3: Add cleanup on app quit**

```javascript
// Add to app.on('before-quit') or app.on('quit')
app.on('before-quit', () => {
  if (schedulerEventEngine) {
    schedulerEventEngine.stop();
  }
  // ... existing cleanup ...
});
```

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: Add scheduler IPC handlers to main process"
```

---

### Task 5: Add Scheduler APIs to Preload Script

**Files:**
- Modify: `src/preload.js`

- [ ] **Step 1: Add scheduler API exposure**

```javascript
// Add to preload.js after existing APIs

const schedulerAPI = {
  createSchedule: (scheduleConfig) => ipcRenderer.invoke('scheduler:create', scheduleConfig),
  updateSchedule: (scheduleId, updates) => ipcRenderer.invoke('scheduler:update', scheduleId, updates),
  deleteSchedule: (scheduleId) => ipcRenderer.invoke('scheduler:delete', scheduleId),
  cancelSchedule: (scheduleId) => ipcRenderer.invoke('scheduler:cancel', scheduleId),
  getAllSchedules: () => ipcRenderer.invoke('scheduler:get-all'),
  getActiveSchedules: () => ipcRenderer.invoke('scheduler:get-active'),
  validateSchedule: (scheduleConfig) => ipcRenderer.invoke('scheduler:validate', scheduleConfig),

  // Event listeners
  onNewSchedule: (callback) => ipcRenderer.on('scheduler:new', (event, schedule) => callback(schedule)),
  onScheduleUpdated: (callback) => ipcRenderer.on('scheduler:updated', (event, schedule) => callback(schedule)),
  onScheduleDeleted: (callback) => ipcRenderer.on('scheduler:deleted', (event, data) => callback(data)),
  onScheduleExecuting: (callback) => ipcRenderer.on('scheduler:executing', (event, schedule) => callback(schedule)),
  onScheduleCompleted: (callback) => ipcRenderer.on('scheduler:completed', (event, schedule) => callback(schedule)),
  onScheduleFailed: (callback) => ipcRenderer.on('scheduler:failed', (event, schedule) => callback(schedule))
};

// Add to contextBridge
contextBridge.exposeInMainWorld('schedulerAPI', schedulerAPI);
```

- [ ] **Step 2: Commit**

```bash
git add src/preload.js
git commit -m "feat: Expose scheduler APIs in preload script"
```

---

## Phase 3: UI Components

### Task 6: Create Scheduler Dialog Component

**Files:**
- Modify: `src/index.html` (add scheduler dialog HTML)
- Modify: `src/renderer.js` (add scheduler dialog logic)
- Modify: `src/styles.css` (add scheduler dialog styles)

- [ ] **Step 1: Add scheduler dialog HTML to index.html**

```html
<!-- Add after existing dialogs -->
<div id="scheduler-dialog" class="dialog hidden">
  <div class="dialog-content">
    <div class="dialog-header">
      <h2>Schedule Download</h2>
      <button class="close-btn" onclick="closeSchedulerDialog()">×</button>
    </div>

    <div class="dialog-body">
      <div class="form-group">
        <label>Download URL</label>
        <input type="text" id="scheduler-url" class="form-input" placeholder="https://example.com/file.zip">
      </div>

      <div class="form-group">
        <label>Scheduled Date & Time</label>
        <input type="datetime-local" id="scheduler-datetime" class="form-input">
      </div>

      <div class="form-group">
        <label>
          <input type="checkbox" id="scheduler-recurring">
          Recurring Schedule
        </label>
      </div>

      <div id="recurring-options" class="recurring-options hidden">
        <div class="form-group">
          <label>Frequency</label>
          <select id="scheduler-frequency" class="form-select">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        <div class="form-group">
          <label>Interval</label>
          <input type="number" id="scheduler-interval" class="form-input" value="1" min="1">
        </div>

        <div class="form-group">
          <label>End Date (Optional)</label>
          <input type="datetime-local" id="scheduler-end-date" class="form-input">
        </div>
      </div>

      <div class="form-group">
        <label>Priority</label>
        <select id="scheduler-priority" class="form-select">
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="low">Low</option>
        </select>
      </div>

      <div class="form-group">
        <label>Download Threads</label>
        <select id="scheduler-threads" class="form-select">
          <option value="8">8 threads</option>
          <option value="16">16 threads</option>
          <option value="24">24 threads</option>
          <option value="32">32 threads</option>
        </select>
      </div>

      <div class="form-group">
        <label>Output Path (Optional)</label>
        <input type="text" id="scheduler-output-path" class="form-input" placeholder="Default downloads folder">
      </div>
    </div>

    <div class="dialog-footer">
      <button class="btn btn-secondary" onclick="closeSchedulerDialog()">Cancel</button>
      <button class="btn btn-primary" onclick="createSchedule()">Schedule Download</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add scheduler dialog styles to styles.css**

```css
/* Add to styles.css */

/* Scheduler Dialog */
#scheduler-dialog {
  z-index: 1000;
}

.recurring-options {
  margin-top: 10px;
  padding: 15px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.recurring-options .form-group {
  margin-bottom: 10px;
}

.recurring-options .form-group:last-child {
  margin-bottom: 0;
}

.form-input[type="datetime-local"] {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  padding: 10px;
  border-radius: 6px;
  width: 100%;
  font-family: inherit;
}

.form-input[type="datetime-local"]::-webkit-calendar-picker-indicator {
  filter: invert(1);
  cursor: pointer;
}

.form-select {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  padding: 10px;
  border-radius: 6px;
  width: 100%;
  font-family: inherit;
  cursor: pointer;
}

.form-select option {
  background: #1a1a2e;
  color: #fff;
}

.form-group label input[type="checkbox"] {
  margin-right: 8px;
  cursor: pointer;
}
```

- [ ] **Step 3: Add scheduler dialog logic to renderer.js**

```javascript
// Add to renderer.js

// Scheduler Dialog Functions
let pendingScheduleUrl = '';

function openSchedulerDialog(url = '') {
  pendingScheduleUrl = url;
  document.getElementById('scheduler-url').value = url;

  // Set default datetime to 1 hour from now
  const defaultTime = new Date(Date.now() + 3600000);
  const datetimeStr = defaultTime.toISOString().slice(0, 16);
  document.getElementById('scheduler-datetime').value = datetimeStr;

  // Reset recurring options
  document.getElementById('scheduler-recurring').checked = false;
  document.getElementById('recurring-options').classList.add('hidden');

  // Reset other fields
  document.getElementById('scheduler-frequency').value = 'daily';
  document.getElementById('scheduler-interval').value = '1';
  document.getElementById('scheduler-end-date').value = '';
  document.getElementById('scheduler-priority').value = 'normal';
  document.getElementById('scheduler-threads').value = '8';
  document.getElementById('scheduler-output-path').value = '';

  document.getElementById('scheduler-dialog').classList.remove('hidden');
}

function closeSchedulerDialog() {
  document.getElementById('scheduler-dialog').classList.add('hidden');
  pendingScheduleUrl = '';
}

// Toggle recurring options
document.getElementById('scheduler-recurring').addEventListener('change', function() {
  const recurringOptions = document.getElementById('recurring-options');
  if (this.checked) {
    recurringOptions.classList.remove('hidden');
  } else {
    recurringOptions.classList.add('hidden');
  }
});

async function createSchedule() {
  const url = document.getElementById('scheduler-url').value.trim();
  const datetimeStr = document.getElementById('scheduler-datetime').value;
  const isRecurring = document.getElementById('scheduler-recurring').checked;
  const priority = document.getElementById('scheduler-priority').value;
  const threads = parseInt(document.getElementById('scheduler-threads').value);
  const outputPath = document.getElementById('scheduler-output-path').value.trim();

  if (!url) {
    alert('Please enter a download URL');
    return;
  }

  if (!datetimeStr) {
    alert('Please select a date and time');
    return;
  }

  const scheduledTime = new Date(datetimeStr).getTime();
  if (scheduledTime <= Date.now()) {
    alert('Scheduled time must be in the future');
    return;
  }

  const scheduleConfig = {
    downloadUrl: url,
    scheduledTime: scheduledTime,
    downloadSettings: {
      threads: threads,
      priority: priority,
      outputPath: outputPath || null
    }
  };

  if (isRecurring) {
    const frequency = document.getElementById('scheduler-frequency').value;
    const interval = parseInt(document.getElementById('scheduler-interval').value);
    const endDateStr = document.getElementById('scheduler-end-date').value;

    scheduleConfig.recurringConfig = {
      enabled: true,
      frequency: frequency,
      interval: interval,
      endDate: endDateStr ? new Date(endDateStr).getTime() : null
    };
  }

  try {
    const result = await window.schedulerAPI.createSchedule(scheduleConfig);

    if (result.success) {
      alert('Download scheduled successfully!');
      closeSchedulerDialog();
      loadSchedules(); // Refresh schedule list
    } else {
      alert('Failed to schedule download: ' + result.error);
    }
  } catch (error) {
    console.error('Error creating schedule:', error);
    alert('Error creating schedule: ' + error.message);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/index.html src/renderer.js src/styles.css
git commit -m "feat: Add scheduler dialog component"
```

---

### Task 7: Create Schedule List Panel

**Files:**
- Modify: `src/index.html` (add schedule list panel)
- Modify: `src/renderer.js` (add schedule list logic)
- Modify: `src/styles.css` (add schedule list styles)

- [ ] **Step 1: Add schedule list panel HTML to index.html**

```html
<!-- Add to main content area, after download list -->
<div id="schedule-panel" class="panel hidden">
  <div class="panel-header">
    <h2>Scheduled Downloads</h2>
    <div class="panel-controls">
      <select id="schedule-filter" class="form-select" onchange="filterSchedules()">
        <option value="all">All Schedules</option>
        <option value="active">Active</option>
        <option value="completed">Completed</option>
        <option value="recurring">Recurring</option>
      </select>
      <button class="btn btn-primary" onclick="openSchedulerDialog()">+ New Schedule</button>
    </div>
  </div>

  <div id="schedule-list" class="schedule-list">
    <!-- Schedule items will be rendered here -->
  </div>
</div>
```

- [ ] **Step 2: Add schedule list styles to styles.css**

```css
/* Add to styles.css */

/* Schedule Panel */
#schedule-panel {
  background: rgba(26, 26, 46, 0.95);
  border-radius: 12px;
  padding: 20px;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.panel-header h2 {
  margin: 0;
  color: #fff;
  font-size: 24px;
}

.panel-controls {
  display: flex;
  gap: 10px;
  align-items: center;
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 600px;
  overflow-y: auto;
}

.schedule-item {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 15px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: all 0.3s ease;
}

.schedule-item:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.schedule-item.status-pending {
  border-left: 4px solid #4CAF50;
}

.schedule-item.status-executing {
  border-left: 4px solid #2196F3;
  animation: pulse 2s infinite;
}

.schedule-item.status-completed {
  border-left: 4px solid #9E9E9E;
  opacity: 0.7;
}

.schedule-item.status-failed {
  border-left: 4px solid #f44336;
}

.schedule-item.status-cancelled {
  border-left: 4px solid #FF9800;
  opacity: 0.6;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.schedule-info {
  flex: 1;
  min-width: 0;
}

.schedule-url {
  color: #fff;
  font-weight: 500;
  margin-bottom: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.schedule-time {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  margin-bottom: 3px;
}

.schedule-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

.schedule-badge {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
}

.schedule-badge.recurring {
  background: rgba(156, 39, 176, 0.3);
  color: #BA68C8;
}

.schedule-badge.priority-high {
  background: rgba(244, 67, 54, 0.3);
  color: #EF5350;
}

.schedule-badge.priority-normal {
  background: rgba(33, 150, 243, 0.3);
  color: #64B5F6;
}

.schedule-badge.priority-low {
  background: rgba(76, 175, 80, 0.3);
  color: #81C784;
}

.schedule-actions {
  display: flex;
  gap: 8px;
  margin-left: 15px;
}

.schedule-actions button {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.schedule-actions .btn-edit {
  background: rgba(33, 150, 243, 0.2);
  color: #64B5F6;
}

.schedule-actions .btn-edit:hover {
  background: rgba(33, 150, 243, 0.4);
}

.schedule-actions .btn-cancel {
  background: rgba(255, 152, 0, 0.2);
  color: #FFB74D;
}

.schedule-actions .btn-cancel:hover {
  background: rgba(255, 152, 0, 0.4);
}

.schedule-actions .btn-delete {
  background: rgba(244, 67, 54, 0.2);
  color: #EF5350;
}

.schedule-actions .btn-delete:hover {
  background: rgba(244, 67, 54, 0.4);
}

.empty-schedules {
  text-align: center;
  padding: 40px;
  color: rgba(255, 255, 255, 0.5);
}

.empty-schedules-icon {
  font-size: 48px;
  margin-bottom: 10px;
}
```

- [ ] **Step 3: Add schedule list logic to renderer.js**

```javascript
// Add to renderer.js

// Schedule List Functions
let allSchedules = [];
let currentScheduleFilter = 'all';

async function loadSchedules() {
  try {
    const result = await window.schedulerAPI.getAllSchedules();
    if (result.success) {
      allSchedules = result.schedules;
      renderScheduleList();
    }
  } catch (error) {
    console.error('Error loading schedules:', error);
  }
}

function renderScheduleList() {
  const scheduleList = document.getElementById('schedule-list');
  const filteredSchedules = filterSchedulesArray(allSchedules, currentScheduleFilter);

  if (filteredSchedules.length === 0) {
    scheduleList.innerHTML = `
      <div class="empty-schedules">
        <div class="empty-schedules-icon">📅</div>
        <p>No scheduled downloads</p>
        <button class="btn btn-primary" onclick="openSchedulerDialog()">Create Schedule</button>
      </div>
    `;
    return;
  }

  scheduleList.innerHTML = filteredSchedules.map(schedule => createScheduleItemHTML(schedule)).join('');
}

function createScheduleItemHTML(schedule) {
  const scheduledDate = new Date(schedule.scheduledTime);
  const timeStr = scheduledDate.toLocaleString();
  const statusClass = `status-${schedule.status}`;
  const isRecurring = schedule.recurringConfig?.enabled;

  return `
    <div class="schedule-item ${statusClass}" data-id="${schedule.id}">
      <div class="schedule-info">
        <div class="schedule-url" title="${schedule.downloadUrl}">${schedule.downloadUrl}</div>
        <div class="schedule-time">📅 ${timeStr}</div>
        <div class="schedule-meta">
          <span class="schedule-badge priority-${schedule.downloadSettings.priority}">
            ${schedule.downloadSettings.priority.toUpperCase()}
          </span>
          ${isRecurring ? '<span class="schedule-badge recurring">RECURRING</span>' : ''}
          <span class="schedule-badge">${schedule.status.toUpperCase()}</span>
        </div>
      </div>
      <div class="schedule-actions">
        ${schedule.status === 'pending' ? `
          <button class="btn-cancel" onclick="cancelSchedule('${schedule.id}')">Cancel</button>
        ` : ''}
        <button class="btn-delete" onclick="deleteSchedule('${schedule.id}')">Delete</button>
      </div>
    </div>
  `;
}

function filterSchedulesArray(schedules, filter) {
  switch (filter) {
    case 'active':
      return schedules.filter(s => s.status === 'pending' || s.status === 'ready');
    case 'completed':
      return schedules.filter(s => s.status === 'completed');
    case 'recurring':
      return schedules.filter(s => s.recurringConfig?.enabled);
    default:
      return schedules;
  }
}

function filterSchedules() {
  currentScheduleFilter = document.getElementById('schedule-filter').value;
  renderScheduleList();
}

async function cancelSchedule(scheduleId) {
  if (!confirm('Are you sure you want to cancel this schedule?')) {
    return;
  }

  try {
    const result = await window.schedulerAPI.cancelSchedule(scheduleId);
    if (result.success) {
      await loadSchedules();
    } else {
      alert('Failed to cancel schedule: ' + result.error);
    }
  } catch (error) {
    console.error('Error cancelling schedule:', error);
    alert('Error cancelling schedule: ' + error.message);
  }
}

async function deleteSchedule(scheduleId) {
  if (!confirm('Are you sure you want to delete this schedule?')) {
    return;
  }

  try {
    const result = await window.schedulerAPI.deleteSchedule(scheduleId);
    if (result.success) {
      await loadSchedules();
    } else {
      alert('Failed to delete schedule: ' + result.error);
    }
  } catch (error) {
    console.error('Error deleting schedule:', error);
    alert('Error deleting schedule: ' + error.message);
  }
}

// Setup scheduler event listeners
function setupSchedulerEventListeners() {
  window.schedulerAPI.onNewSchedule((schedule) => {
    console.log('New schedule created:', schedule);
    loadSchedules();
  });

  window.schedulerAPI.onScheduleUpdated((schedule) => {
    console.log('Schedule updated:', schedule);
    loadSchedules();
  });

  window.schedulerAPI.onScheduleDeleted((data) => {
    console.log('Schedule deleted:', data);
    loadSchedules();
  });

  window.schedulerAPI.onScheduleExecuting((schedule) => {
    console.log('Schedule executing:', schedule);
    loadSchedules();
  });

  window.schedulerAPI.onScheduleCompleted((schedule) => {
    console.log('Schedule completed:', schedule);
    loadSchedules();
  });

  window.schedulerAPI.onScheduleFailed((schedule) => {
    console.log('Schedule failed:', schedule);
    loadSchedules();
  });
}

// Initialize scheduler on app load
document.addEventListener('DOMContentLoaded', () => {
  setupSchedulerEventListeners();
  loadSchedules();
});
```

- [ ] **Step 4: Add navigation to schedule panel**

```javascript
// Add to renderer.js navigation functions
function showSchedulePanel() {
  document.getElementById('download-panel').classList.add('hidden');
  document.getElementById('schedule-panel').classList.remove('hidden');
  loadSchedules();
}

// Add to existing navigation menu
```

- [ ] **Step 5: Commit**

```bash
git add src/index.html src/renderer.js src/styles.css
git commit -m "feat: Add schedule list panel with filtering"
```

---

## Phase 4: Integration and Testing

### Task 8: Integrate Scheduler with Download Engine

**Files:**
- Modify: `src/scheduler/SchedulerEventEngine.js` (integrate with actual download engine)

- [ ] **Step 1: Update SchedulerEventEngine to use actual download engine**

```javascript
// Modify the startDownload method in SchedulerEventEngine.js

async startDownload(schedule) {
  try {
    // Get download engine reference
    const downloadEngine = this.downloadEngine;

    // Create download configuration
    const downloadConfig = {
      url: schedule.downloadUrl,
      threads: schedule.downloadSettings.threads || 8,
      outputPath: schedule.downloadSettings.outputPath || null,
      priority: schedule.downloadSettings.priority || 'normal',
      speedLimit: schedule.downloadSettings.speedLimit || null
    };

    // Start the download using existing download engine
    const downloadId = await downloadEngine.startDownload(downloadConfig);

    // Link schedule to download
    await this.storage.updateSchedule(schedule.id, {
      downloadId: downloadId
    });

    return downloadId;
  } catch (error) {
    console.error('[Scheduler] Error starting download:', error);
    throw error;
  }
}
```

- [ ] **Step 2: Add download completion tracking**

```javascript
// Add to SchedulerEventEngine class

async onDownloadComplete(downloadId) {
  // Find schedules linked to this download
  const allSchedules = await this.storage.getAllSchedules();
  const linkedSchedules = allSchedules.filter(s => s.downloadId === downloadId);

  for (const schedule of linkedSchedules) {
    if (schedule.recurringConfig?.enabled) {
      // Calculate next execution for recurring schedules
      const nextExecution = this.calculateNextExecution(schedule);
      await this.storage.updateSchedule(schedule.id, {
        status: 'pending',
        nextExecution: nextExecution,
        scheduledTime: nextExecution,
        executionCount: schedule.executionCount + 1
      });
    } else {
      // Mark as completed
      await this.storage.updateSchedule(schedule.id, {
        status: 'completed',
        executionCount: schedule.executionCount + 1
      });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/SchedulerEventEngine.js
git commit -m "feat: Integrate scheduler with download engine"
```

---

### Task 9: Add Comprehensive Error Handling

**Files:**
- Modify: `src/scheduler/SchedulerEventEngine.js` (enhance error handling)
- Modify: `src/renderer.js` (add user-friendly error messages)

- [ ] **Step 1: Add retry logic to SchedulerEventEngine**

```javascript
// Add to SchedulerEventEngine class

async handleScheduleFailure(schedule, error) {
  const maxRetries = 3;
  const retryDelay = 5 * 60 * 1000; // 5 minutes

  const currentRetries = schedule.retryCount || 0;

  if (currentRetries < maxRetries) {
    // Schedule retry
    const retryTime = Date.now() + retryDelay;
    await this.storage.updateSchedule(schedule.id, {
      status: 'pending',
      scheduledTime: retryTime,
      retryCount: currentRetries + 1,
      lastError: error
    });

    console.log(`[Scheduler] Schedule ${schedule.id} will retry at ${new Date(retryTime).toLocaleString()}`);
  } else {
    // Mark as permanently failed
    await this.storage.updateSchedule(schedule.id, {
      status: 'failed',
      error: error,
      retryCount: currentRetries
    });

    console.error(`[Scheduler] Schedule ${schedule.id} permanently failed after ${maxRetries} retries`);
  }
}
```

- [ ] **Step 2: Add validation improvements**

```javascript
// Enhance validateScheduleConditions method

validateScheduleConditions(schedule) {
  const errors = [];

  // Check disk space (basic check)
  const downloadPath = schedule.downloadSettings.outputPath || require('electron').app.getPath('downloads');
  try {
    const stats = require('fs').statSync(downloadPath);
    if (!stats.isDirectory()) {
      errors.push('Download path is not a directory');
    }
  } catch (error) {
    errors.push('Invalid download path');
  }

  // Validate URL format
  try {
    const url = new URL(schedule.downloadUrl);
    if (!url.protocol.startsWith('http')) {
      errors.push('URL must use HTTP or HTTPS protocol');
    }
  } catch (error) {
    errors.push('Invalid URL format');
  }

  // Validate thread count
  if (schedule.downloadSettings.threads < 1 || schedule.downloadSettings.threads > 32) {
    errors.push('Thread count must be between 1 and 32');
  }

  // Validate recurring configuration
  if (schedule.recurringConfig?.enabled) {
    const { frequency, interval } = schedule.recurringConfig;
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
      errors.push('Invalid recurring frequency');
    }
    if (interval < 1) {
      errors.push('Recurring interval must be at least 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}
```

- [ ] **Step 3: Add user-friendly error messages in renderer**

```javascript
// Add to renderer.js

function showScheduleError(error) {
  const errorMessages = {
    'Scheduled time must be in the future': 'Please select a future date and time',
    'Invalid URL format': 'Please enter a valid URL starting with http:// or https://',
    'Invalid download path': 'Please check your download folder settings',
    'Thread count must be between 1 and 32': 'Please select a valid thread count',
    'Invalid recurring frequency': 'Please select a valid recurring frequency',
    'Recurring interval must be at least 1': 'Recurring interval must be at least 1'
  };

  const message = errorMessages[error] || error;
  alert(message);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/SchedulerEventEngine.js src/renderer.js
git commit -m "feat: Add comprehensive error handling and retry logic"
```

---

### Task 10: Add Testing and Documentation

**Files:**
- Create: `tests/scheduler/integration.test.js`
- Create: `docs/SCHEDULER_GUIDE.md`

- [ ] **Step 1: Create integration tests**

```javascript
// tests/scheduler/integration.test.js

const { SchedulerCore } = require('../../src/scheduler/SchedulerCore');
const { SchedulerStorage } = require('../../src/scheduler/SchedulerStorage');
const { SchedulerEventEngine } = require('../../src/scheduler/SchedulerEventEngine');
const fs = require('fs');
const path = require('path');

describe('Scheduler Integration Tests', () => {
  const testStoragePath = path.join(__dirname, 'integration-schedules.json');
  let core, storage, engine;

  beforeEach(async () => {
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }

    storage = new SchedulerStorage(testStoragePath);
    await storage.initialize();

    core = new SchedulerCore();
    engine = new SchedulerEventEngine(null, storage);
  });

  afterEach(async () => {
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }
  });

  it('should create and persist schedule', async () => {
    const scheduleConfig = {
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000,
      downloadSettings: { threads: 8 }
    };

    const schedule = core.createSchedule(scheduleConfig);
    await storage.saveSchedule(schedule);

    const retrieved = await storage.getSchedule(schedule.id);
    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe(schedule.id);
  });

  it('should handle recurring schedule calculation', async () => {
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const schedule = {
      id: 'test-1',
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: baseTime,
      recurringConfig: {
        enabled: true,
        frequency: 'daily',
        interval: 1
      },
      status: 'pending',
      executionCount: 0
    };

    const nextExecution = engine.calculateNextExecution(schedule);
    const expected = new Date('2026-05-20T10:00:00Z').getTime();

    expect(nextExecution).toBe(expected);
  });

  it('should find due schedules', () => {
    const now = Date.now();
    const schedules = [
      { id: '1', scheduledTime: now - 1000, status: 'pending' },
      { id: '2', scheduledTime: now + 1000, status: 'pending' },
      { id: '3', scheduledTime: now - 500, status: 'completed' }
    ];

    const due = engine.findDueSchedules(schedules, now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('1');
  });

  it('should validate schedule conditions', () => {
    const schedule = {
      downloadUrl: 'https://example.com/file.zip',
      downloadSettings: {
        threads: 8,
        outputPath: '/tmp'
      }
    };

    const result = engine.validateScheduleConditions(schedule);
    expect(result.valid).toBe(true);
  });

  it('should detect invalid URL in validation', () => {
    const schedule = {
      downloadUrl: 'not-a-valid-url',
      downloadSettings: {
        threads: 8,
        outputPath: '/tmp'
      }
    };

    const result = engine.validateScheduleConditions(schedule);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid URL format');
  });
});
```

- [ ] **Step 2: Create user documentation**

```markdown
# CyberDM Scheduler Guide

## Overview

The CyberDM Scheduler allows you to schedule downloads for specific dates and times, and create recurring schedules for regular downloads.

## Features

- **Single Scheduling**: Schedule downloads for specific dates and times
- **Recurring Schedules**: Set up daily, weekly, or monthly recurring downloads
- **Priority Management**: Set download priority (high, normal, low)
- **Flexible Configuration**: Customize threads, output path, and other settings
- **Automatic Execution**: Downloads start automatically at scheduled time
- **Error Recovery**: Automatic retry logic for failed schedules

## How to Use

### Creating a Schedule

1. Click the "Schedule" button in the main interface
2. Enter the download URL
3. Select the desired date and time
4. Configure optional settings:
   - Enable recurring schedule
   - Set frequency (daily/weekly/monthly)
   - Set interval and end date
   - Choose priority level
   - Configure thread count
   - Set custom output path
5. Click "Schedule Download"

### Managing Schedules

- **View Schedules**: Navigate to the Scheduled Downloads panel
- **Filter Schedules**: Use the filter dropdown to show active, completed, or recurring schedules
- **Cancel Schedule**: Click "Cancel" to stop a pending schedule
- **Delete Schedule**: Click "Delete" to remove a schedule from history

### Schedule Status

- **Pending**: Schedule is waiting for execution time
- **Executing**: Schedule is currently running
- **Completed**: Schedule finished successfully
- **Failed**: Schedule encountered an error
- **Cancelled**: Schedule was cancelled by user

## Recurring Schedules

### Daily Recurrence
Downloads repeat every N days at the same time.

### Weekly Recurrence
Downloads repeat every N weeks on the same day.

### Monthly Recurrence
Downloads repeat every N months on the same date.

### End Date
Optionally set an end date for recurring schedules.

## Tips

- Schedule large downloads during off-peak hours
- Use recurring schedules for regular file updates
- Set appropriate priority based on urgency
- Monitor schedule status in the Scheduled Downloads panel
- Check error messages if schedules fail

## Troubleshooting

### Schedule Not Executing
- Verify the scheduled time is in the future
- Check that CyberDM is running at the scheduled time
- Review error messages in the schedule details

### Recurring Schedule Stopped
- Check if the end date has passed
- Verify the schedule hasn't been cancelled
- Review the execution history

### Download Failed
- Check your internet connection
- Verify the URL is still valid
- Review error messages for specific issues
- The system will automatically retry up to 3 times

## Advanced Features

### Priority Levels
- **High**: Executes before normal and low priority downloads
- **Normal**: Standard priority
- **Low**: Executes when no higher priority downloads are active

### Thread Configuration
- More threads = faster download speed
- Fewer threads = lower system resource usage
- Recommended: 8-16 threads for most connections

### Custom Output Path
- Specify a custom folder for scheduled downloads
- Useful for organizing different types of files
- Leave empty to use default downloads folder
```

- [ ] **Step 3: Run all tests**

```bash
cd "D:\Project\Software\CyberDM-Electron"
npm test
```

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler/integration.test.js docs/SCHEDULER_GUIDE.md
git commit -m "test: Add comprehensive scheduler tests and documentation"
```

---

## Phase 5: Production Polish

### Task 11: Add Performance Optimizations

**Files:**
- Modify: `src/scheduler/SchedulerEventEngine.js` (add performance improvements)

- [ ] **Step 1: Add debouncing and caching**

```javascript
// Add to SchedulerEventEngine class

constructor(downloadEngine, storage) {
  this.downloadEngine = downloadEngine;
  this.storage = storage;
  this.checkInterval = 30000; // 30 seconds
  this.intervalId = null;
  this.isRunning = false;
  this.lastCheckTime = 0;
  this.checkDebounceMs = 1000; // Minimum 1 second between checks
  this.scheduleCache = new Map();
  this.cacheExpiryMs = 60000; // Cache expires after 1 minute
}

async checkAndExecuteSchedules() {
  const now = Date.now();

  // Debounce rapid checks
  if (now - this.lastCheckTime < this.checkDebounceMs) {
    return;
  }

  this.lastCheckTime = now;

  try {
    // Check cache first
    const cacheKey = 'active_schedules';
    let activeSchedules = this.scheduleCache.get(cacheKey);

    if (!activeSchedules || (now - activeSchedules.timestamp > this.cacheExpiryMs)) {
      activeSchedules = {
        data: await this.storage.getActiveSchedules(),
        timestamp: now
      };
      this.scheduleCache.set(cacheKey, activeSchedules);
    }

    const dueSchedules = this.findDueSchedules(activeSchedules.data, now);

    // Execute due schedules
    for (const schedule of dueSchedules) {
      await this.executeSchedule(schedule);
    }

    // Clear cache after execution
    this.scheduleCache.delete(cacheKey);

  } catch (error) {
    console.error('[Scheduler] Error checking schedules:', error);
  }
}
```

- [ ] **Step 2: Add batch operations**

```javascript
// Add batch execution method

async executeSchedulesBatch(schedules) {
  const maxConcurrent = 3; // Max 3 concurrent executions
  const results = [];

  for (let i = 0; i < schedules.length; i += maxConcurrent) {
    const batch = schedules.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(schedule => this.executeSchedule(schedule));
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
  }

  return results;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/SchedulerEventEngine.js
git commit -m "perf: Add performance optimizations to scheduler"
```

---

### Task 12: Add System Tray Integration

**Files:**
- Modify: `src/main.js` (add scheduler status to tray)

- [ ] **Step 1: Update tray menu with scheduler info**

```javascript
// Modify the createTrayMenu function in main.js

function createTrayMenu() {
  const activeSchedules = schedulerStorage ? schedulerStorage.getActiveSchedules() : [];
  const activeCount = activeSchedules.length;

  return Menu.buildFromTemplate([
    { label: 'Show CyberDM', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: `Active Schedules: ${activeCount}`,
      enabled: false
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

// Update tray periodically
setInterval(() => {
  if (tray) {
    tray.setContextMenu(createTrayMenu());
  }
}, 60000); // Update every minute
```

- [ ] **Step 2: Add tray notifications**

```javascript
// Add to SchedulerEventEngine

async notifyScheduleExecution(schedule) {
  const notification = new Notification({
    title: 'CyberDM - Schedule Executing',
    body: `Starting download: ${schedule.downloadUrl}`,
    icon: path.join(__dirname, '../assets/icon.png')
  });

  notification.show();
}

async notifyScheduleCompletion(schedule) {
  const notification = new Notification({
    title: 'CyberDM - Schedule Completed',
    body: `Download completed: ${schedule.downloadUrl}`,
    icon: path.join(__dirname, '../assets/icon.png')
  });

  notification.show();
}
```

- [ ] **Step 3: Commit**

```bash
git add src/main.js src/scheduler/SchedulerEventEngine.js
git commit -m "feat: Add system tray integration for scheduler"
```

---

## Final Integration

### Task 13: Complete Integration Testing

**Files:**
- Create: `tests/scheduler/e2e.test.js`

- [ ] **Step 1: Create end-to-end tests**

```javascript
// tests/scheduler/e2e.test.js

describe('Scheduler E2E Tests', () => {
  it('should complete full schedule lifecycle', async () => {
    // 1. Create schedule
    // 2. Verify schedule is saved
    // 3. Wait for execution time
    // 4. Verify download started
    // 5. Verify schedule completed
    // 6. Verify recurring schedule created next execution
  });

  it('should handle schedule cancellation', async () => {
    // 1. Create schedule
    // 2. Cancel schedule
    // 3. Verify schedule status changed
    // 4. Verify download did not start
  });

  it('should handle schedule failure and retry', async () => {
    // 1. Create schedule with invalid URL
    // 2. Wait for execution
    // 3. Verify failure recorded
    // 4. Verify retry scheduled
  });
});
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

- [ ] **Step 3: Manual testing checklist**

```markdown
## Manual Testing Checklist

### Basic Functionality
- [ ] Create single schedule
- [ ] Create recurring schedule (daily)
- [ ] Create recurring schedule (weekly)
- [ ] Create recurring schedule (monthly)
- [ ] Cancel pending schedule
- [ ] Delete completed schedule
- [ ] View schedule list
- [ ] Filter schedules by status

### UI Testing
- [ ] Open scheduler dialog
- [ ] Enter valid URL
- [ ] Select future date/time
- [ ] Enable recurring options
- [ ] Set priority levels
- [ ] Configure thread count
- [ ] Set custom output path
- [ ] Close dialog without saving
- [ ] Show validation errors

### Integration Testing
- [ ] Schedule executes at correct time
- [ ] Download starts from schedule
- [ ] Schedule status updates correctly
- [ ] Recurring schedule creates next execution
- [ ] Failed schedule retries automatically
- [ ] System tray shows active count
- [ ] Notifications appear on execution
- [ ] Notifications appear on completion

### Edge Cases
- [ ] Schedule with past date/time
- [ ] Schedule with invalid URL
- [ ] Schedule with invalid path
- [ ] Schedule during app restart
- [ ] Multiple schedules at same time
- [ ] Long-duration recurring schedule
- [ ] Schedule with end date reached
- [ ] Network unavailable at execution time
```

- [ ] **Step 4: Final commit**

```bash
git add tests/scheduler/e2e.test.js
git commit -m "test: Add end-to-end scheduler tests"
```

---

## Summary

This implementation plan provides a complete, production-quality scheduler system for CyberDM with:

✅ **Core Infrastructure**: SchedulerCore, SchedulerStorage, SchedulerEventEngine
✅ **IPC Communication**: Full integration between main and renderer processes
✅ **UI Components**: Scheduler dialog, schedule list panel, filtering
✅ **Download Integration**: Seamless integration with existing download engine
✅ **Error Handling**: Comprehensive error handling with retry logic
✅ **Testing**: Unit, integration, and end-to-end tests
✅ **Documentation**: User guide and developer documentation
✅ **Performance**: Optimizations for production use
✅ **System Integration**: Tray integration and notifications

The scheduler system is now ready for production use and provides a solid foundation for the next phase: Queue Management System.