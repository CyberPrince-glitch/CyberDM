const { v4: uuidv4 } = require('uuid');

// ============ CONSTANTS ============

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const SCHEDULE_STATUS = Object.freeze({
    PENDING: 'pending',
    ACTIVE: 'active',
    PAUSED: 'paused',
    EXPIRED: 'expired',
    ERROR: 'error'
});

const PROFILE_MODE = Object.freeze({
    UNLIMITED: 'unlimited',
    LIMITED: 'limited',
    OFFLINE: 'offline'
});

// ============ HELPERS ============

const DEFAULT_PROFILES = () => ({
    [PROFILE_MODE.UNLIMITED]: {
        mode: PROFILE_MODE.UNLIMITED,
        speedLimitBps: 0,
        maxConcurrent: 8,
        chunkCount: 8,
        enabled: true
    },
    [PROFILE_MODE.LIMITED]: {
        mode: PROFILE_MODE.LIMITED,
        speedLimitBps: 512 * 1024,
        maxConcurrent: 2,
        chunkCount: 4,
        enabled: true
    },
    [PROFILE_MODE.OFFLINE]: {
        mode: PROFILE_MODE.OFFLINE,
        speedLimitBps: 0,
        maxConcurrent: 0,
        chunkCount: 0,
        enabled: true
    }
});

const sanitizeRules = (rules) => {
    if (!rules || typeof rules !== 'object') return {};
    const clean = {};
    for (const day of DAYS) {
        const dayRules = rules[day];
        if (Array.isArray(dayRules)) {
            clean[day] = dayRules.map((r) => sanitizeRule(r)).filter(Boolean);
        } else {
            clean[day] = [];
        }
    }
    return clean;
};

const sanitizeRule = (rule) => {
    if (!rule || typeof rule !== 'object') return null;
    const startMin = parseTimeToMinutes(rule.startTime);
    const endMin = parseTimeToMinutes(rule.endTime);
    if (startMin === null || endMin === null) return null;

    const validProfiles = Object.values(PROFILE_MODE);
    const profile = validProfiles.includes(rule.profile) ? rule.profile : PROFILE_MODE.LIMITED;

    return {
        id: typeof rule.id === 'string' && rule.id.length ? rule.id : uuidv4(),
        label: typeof rule.label === 'string' ? rule.label.trim() : '',
        profile,
        startTime: rule.startTime,
        endTime: rule.endTime,
        startMin,
        endMin,
        enabled: rule.enabled !== false
    };
};

const parseTimeToMinutes = (time) => {
    if (typeof time !== 'string') return null;
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
};

const formatMinutes = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const nowMinutes = (date) => {
    return date.getHours() * 60 + date.getMinutes();
};

const dayKey = (date) => DAYS[date.getDay()];

// ============ CORE ============

class BandwidthSchedulerCore {
    constructor(options = {}) {
        this.schedules = new Map();      // id -> { rules, activeProfile, status, ... }
        this.profiles = { ...DEFAULT_PROFILES() };
        this.activeDownloads = new Map(); // downloadId -> current rules
        this.tickListeners = new Set();
        this.now = options.now || (() => new Date());
        this.tickIntervalMs = options.tickIntervalMs || 60_000;
        this._lastTick = 0;
    }

    // ---- Profile management ----

    setProfile(name, profile) {
        if (!Object.values(PROFILE_MODE).includes(name)) {
            throw new Error(`Unknown profile: ${name}`);
        }
        const sanitized = this._sanitizeProfile(profile);
        this.profiles[name] = sanitized;
        return sanitized;
    }

    getProfile(name) {
        return this.profiles[name] || null;
    }

    getAllProfiles() {
        return { ...this.profiles };
    }

    _sanitizeProfile(profile) {
        const speed = Math.max(0, parseInt(profile.speedLimitBps, 10) || 0);
        const concurrent = Math.max(0, parseInt(profile.maxConcurrent, 10) || 0);
        const chunk = Math.max(0, Math.min(32, parseInt(profile.chunkCount, 10) || 0));
        const mode = Object.values(PROFILE_MODE).includes(profile.mode) ? profile.mode : PROFILE_MODE.LIMITED;
        return {
            mode,
            speedLimitBps: speed,
            maxConcurrent: concurrent,
            chunkCount: chunk,
            enabled: profile.enabled !== false
        };
    }

    // ---- Schedule CRUD ----

    createSchedule(config = {}) {
        const rules = sanitizeRules(config.rules);
        const schedule = {
            id: typeof config.id === 'string' && config.id.length ? config.id : uuidv4(),
            name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'New Schedule',
            rules,
            activeProfile: null,
            status: SCHEDULE_STATUS.PENDING,
            enabled: config.enabled !== false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastTickAt: null,
            nextChangeAt: null,
            stats: {
                totalTicks: 0,
                rulesApplied: 0
            }
        };
        this.schedules.set(schedule.id, schedule);
        return schedule;
    }

    getSchedule(id) {
        return this.schedules.get(id) || null;
    }

    getAllSchedules() {
        return Array.from(this.schedules.values());
    }

    updateSchedule(id, updates) {
        const schedule = this.schedules.get(id);
        if (!schedule) return null;
        if (updates.name !== undefined) {
            schedule.name = typeof updates.name === 'string' ? updates.name.trim() : schedule.name;
        }
        if (updates.enabled !== undefined) {
            schedule.enabled = !!updates.enabled;
        }
        if (updates.rules) {
            schedule.rules = sanitizeRules(updates.rules);
        }
        schedule.updatedAt = Date.now();
        return schedule;
    }

    deleteSchedule(id) {
        return this.schedules.delete(id);
    }

    enableSchedule(id) {
        const s = this.schedules.get(id);
        if (!s) return null;
        s.enabled = true;
        s.status = SCHEDULE_STATUS.PENDING;
        s.updatedAt = Date.now();
        return s;
    }

    disableSchedule(id) {
        const s = this.schedules.get(id);
        if (!s) return null;
        s.enabled = false;
        s.status = SCHEDULE_STATUS.PAUSED;
        s.updatedAt = Date.now();
        return s;
    }

    // ---- Rule management (helpers) ----

    addRule(scheduleId, day, rule) {
        const schedule = this.schedules.get(scheduleId);
        if (!schedule) return null;
        if (!DAYS.includes(day)) throw new Error(`Invalid day: ${day}`);
        const sanitized = sanitizeRule(rule);
        if (!sanitized) throw new Error('Invalid rule');
        schedule.rules[day].push(sanitized);
        schedule.updatedAt = Date.now();
        return sanitized;
    }

    removeRule(scheduleId, day, ruleId) {
        const schedule = this.schedules.get(scheduleId);
        if (!schedule) return false;
        const before = schedule.rules[day].length;
        schedule.rules[day] = schedule.rules[day].filter((r) => r.id !== ruleId);
        const removed = before !== schedule.rules[day].length;
        if (removed) schedule.updatedAt = Date.now();
        return removed;
    }

    updateRule(scheduleId, day, ruleId, updates) {
        const schedule = this.schedules.get(scheduleId);
        if (!schedule) return null;
        const idx = schedule.rules[day].findIndex((r) => r.id === ruleId);
        if (idx === -1) return null;
        const merged = { ...schedule.rules[day][idx], ...updates };
        const sanitized = sanitizeRule(merged);
        if (!sanitized) return null;
        schedule.rules[day][idx] = sanitized;
        schedule.updatedAt = Date.now();
        return sanitized;
    }

    // ---- Time math ----

    /**
     * Given rules and a Date, returns the profile name that should be active.
     * Returns null if no rule matches (means "use default unlimited").
     */
    resolveActiveProfile(rules, date) {
        const day = dayKey(date);
        const mins = nowMinutes(date);
        const dayRules = (rules[day] || []).filter((r) => r.enabled);

        for (const rule of dayRules) {
            if (this._minuteInRange(mins, rule.startMin, rule.endMin)) {
                return rule.profile;
            }
        }
        return null;
    }

    _minuteInRange(min, start, end) {
        if (start === end) return false;
        if (start < end) {
            return min >= start && min < end;
        }
        // wraps midnight (e.g. 22:00 -> 06:00)
        return min >= start || min < end;
    }

    /**
     * Find the next minute boundary where the active profile changes.
     */
    nextChangeAt(rules, fromDate) {
        const day = dayKey(fromDate);
        const mins = nowMinutes(fromDate);
        const dayRules = (rules[day] || []).filter((r) => r.enabled);

        let soonest = null;
        for (const rule of dayRules) {
            for (const boundary of [rule.startMin, rule.endMin]) {
                if (boundary > mins && (soonest === null || boundary < soonest)) {
                    soonest = boundary;
                }
            }
        }
        if (soonest !== null) {
            const next = new Date(fromDate);
            next.setHours(Math.floor(soonest / 60), soonest % 60, 0, 0);
            return next.getTime();
        }
        // jump to start of next day
        const tomorrow = new Date(fromDate);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow.getTime();
    }

    // ---- Tick / state engine ----

    /**
     * Run one evaluation tick. Returns array of change events.
     * Each event: { scheduleId, previousProfile, newProfile, timestamp }
     */
    tick(date = this.now()) {
        const events = [];
        const ts = date.getTime();
        this._lastTick = ts;

        for (const schedule of this.schedules.values()) {
            if (!schedule.enabled) {
                if (schedule.status !== SCHEDULE_STATUS.PAUSED) {
                    schedule.status = SCHEDULE_STATUS.PAUSED;
                    events.push({ scheduleId: schedule.id, type: 'disabled', previousProfile: schedule.activeProfile, newProfile: null, timestamp: ts });
                }
                continue;
            }

            const prev = schedule.activeProfile;
            const next = this.resolveActiveProfile(schedule.rules, date);
            schedule.stats.totalTicks += 1;
            schedule.lastTickAt = ts;
            schedule.nextChangeAt = this.nextChangeAt(schedule.rules, date);

            if (next !== prev) {
                schedule.activeProfile = next;
                schedule.stats.rulesApplied += 1;
                schedule.status = next ? SCHEDULE_STATUS.ACTIVE : SCHEDULE_STATUS.PENDING;
                events.push({
                    scheduleId: schedule.id,
                    type: 'profile-changed',
                    previousProfile: prev,
                    newProfile: next,
                    timestamp: ts
                });
            } else if (schedule.status === SCHEDULE_STATUS.PAUSED) {
                schedule.status = next ? SCHEDULE_STATUS.ACTIVE : SCHEDULE_STATUS.PENDING;
            }
        }

        for (const listener of this.tickListeners) {
            try {
                listener({ events, timestamp: ts });
            } catch (err) {
                // listener errors must not break the engine
            }
        }

        return events;
    }

    onTick(listener) {
        this.tickListeners.add(listener);
        return () => this.tickListeners.delete(listener);
    }

    /**
     * Get the currently enforced settings for a download.
     * If no schedule matches, returns the unlimited profile as default.
     */
    getEnforcedSettings() {
        const profileName = this._getCurrentProfileName();
        const profile = this.profiles[profileName] || this.profiles[PROFILE_MODE.UNLIMITED];
        return {
            profileName,
            speedLimitBps: profile.speedLimitBps,
            maxConcurrent: profile.maxConcurrent,
            chunkCount: profile.chunkCount,
            enforced: profileName !== PROFILE_MODE.UNLIMITED
        };
    }

    _getCurrentProfileName() {
        // Pick the first schedule's resolved profile, with later schedules overriding earlier.
        // In a real system, multiple schedules could be combined — for this MVP we use the
        // most recently activated one.
        let chosen = null;
        let chosenTs = -1;
        for (const schedule of this.schedules.values()) {
            if (!schedule.enabled || !schedule.activeProfile) continue;
            if (schedule.lastTickAt !== null && schedule.lastTickAt >= chosenTs) {
                chosen = schedule.activeProfile;
                chosenTs = schedule.lastTickAt;
            }
        }
        return chosen;
    }

    /**
     * Persist/load schedules as JSON-serializable object.
     */
    serialize() {
        return {
            version: 1,
            schedules: Array.from(this.schedules.values()),
            profiles: this.profiles,
            exportedAt: Date.now()
        };
    }

    static hydrate(data, options = {}) {
        const core = new BandwidthSchedulerCore(options);
        if (data && typeof data === 'object') {
            if (data.profiles) {
                for (const [name, profile] of Object.entries(data.profiles)) {
                    try {
                        core.setProfile(name, profile);
                    } catch (err) {
                        // skip unknown profile names
                    }
                }
            }
            if (Array.isArray(data.schedules)) {
                for (const s of data.schedules) {
                    core.schedules.set(s.id, s);
                }
            }
        }
        return core;
    }
}

module.exports = {
    BandwidthSchedulerCore,
    PROFILE_MODE,
    SCHEDULE_STATUS,
    DAYS,
    formatMinutes,
    parseTimeToMinutes,
    DEFAULT_PROFILES
};
