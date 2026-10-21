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
      createdBy: config.createdBy || 'manual',
      tags: config.tags || []
    };

    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  validateScheduleTime(timestamp) {
    const now = Date.now();
    if (timestamp < now) {
      return { valid: false, error: ' Scheduled time is in the past' };
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
    schedule.updatedAt = Date.now() + 1; // Ensure timestamp increases
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