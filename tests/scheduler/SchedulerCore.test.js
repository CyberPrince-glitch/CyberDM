const { SchedulerCore } = require('../../src/scheduler/SchedulerCore');

describe('SchedulerCore', () => {
  let core;

  beforeEach(() => {
    core = new SchedulerCore();
  });

  it('should create a valid schedule object', () => {
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000, // 1 hour from now
      downloadSettings: { threads: 8, outputPath: '/downloads' }
    });

    expect(schedule.id).toBeDefined();
    expect(schedule.status).toBe('pending');
    expect(schedule.downloadUrl).toBe('https://example.com/file.zip');
    expect(schedule.downloadSettings.threads).toBe(8);
    expect(schedule.downloadSettings.outputPath).toBe('/downloads');
    expect(schedule.createdAt).toBeDefined();
    expect(schedule.updatedAt).toBeDefined();
  });

  it('should validate schedule time is in future', () => {
    const result = core.validateScheduleTime(Date.now() - 1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('past');
  });

  it('should validate future schedule time', () => {
    const result = core.validateScheduleTime(Date.now() + 3600000);
    expect(result.valid).toBe(true);
  });

  it('should calculate next execution for daily recurring', () => {
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const next = core.calculateNextExecution(baseTime, {
      enabled: true,
      frequency: 'daily',
      interval: 1
    });

    const expected = new Date('2026-05-20T10:00:00Z').getTime();
    expect(next).toBe(expected);
  });

  it('should calculate next execution for weekly recurring', () => {
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const next = core.calculateNextExecution(baseTime, {
      enabled: true,
      frequency: 'weekly',
      interval: 1
    });

    const expected = new Date('2026-05-26T10:00:00Z').getTime();
    expect(next).toBe(expected);
  });

  it('should calculate next execution for monthly recurring', () => {
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const next = core.calculateNextExecution(baseTime, {
      enabled: true,
      frequency: 'monthly',
      interval: 1
    });

    const expected = new Date('2026-06-19T10:00:00Z').getTime();
    expect(next).toBe(expected);
  });

  it('should return null for disabled recurring', () => {
    const baseTime = new Date('2026-05-19T10:00:00Z').getTime();
    const next = core.calculateNextExecution(baseTime, {
      enabled: false,
      frequency: 'daily',
      interval: 1
    });

    expect(next).toBeNull();
  });

  it('should update schedule status', () => {
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000
    });

    // Small delay to ensure timestamp difference
    const originalUpdatedAt = schedule.updatedAt;

    const updated = core.updateScheduleStatus(schedule.id, 'executing');
    expect(updated.status).toBe('executing');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('should get schedule by id', () => {
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000
    });

    const retrieved = core.getSchedule(schedule.id);
    expect(retrieved).toBe(schedule);
  });

  it('should get all schedules', () => {
    core.createSchedule({
      downloadUrl: 'https://example.com/file1.zip',
      scheduledTime: Date.now() + 3600000
    });

    core.createSchedule({
      downloadUrl: 'https://example.com/file2.zip',
      scheduledTime: Date.now() + 7200000
    });

    const all = core.getAllSchedules();
    expect(all.length).toBe(2);
  });

  it('should create schedule with default values', () => {
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000
    });

    expect(schedule.downloadSettings.threads).toBe(8);
    expect(schedule.downloadSettings.priority).toBe('normal');
    expect(schedule.downloadSettings.speedLimit).toBeNull();
    expect(schedule.downloadSettings.outputPath).toBe('');
    expect(schedule.recurringConfig).toBeNull();
    expect(schedule.tags).toEqual([]);
    expect(schedule.createdBy).toBe('manual');
  });

  it('should create schedule with custom values', () => {
    const schedule = core.createSchedule({
      downloadUrl: 'https://example.com/file.zip',
      scheduledTime: Date.now() + 3600000,
      downloadSettings: {
        threads: 16,
        priority: 'high',
        speedLimit: 1000000,
        outputPath: '/custom/path'
      },
      recurringConfig: {
        enabled: true,
        frequency: 'daily',
        interval: 1
      },
      tags: ['important', 'backup'],
      createdBy: 'auto'
    });

    expect(schedule.downloadSettings.threads).toBe(16);
    expect(schedule.downloadSettings.priority).toBe('high');
    expect(schedule.downloadSettings.speedLimit).toBe(1000000);
    expect(schedule.downloadSettings.outputPath).toBe('/custom/path');
    expect(schedule.recurringConfig.enabled).toBe(true);
    expect(schedule.tags).toEqual(['important', 'backup']);
    expect(schedule.createdBy).toBe('auto');
  });
});