export class Logger {
    constructor(config) {
        this.config = config;
    }
    formatLog(entry) {
        if (this.config.format === 'json') {
            return JSON.stringify(entry);
        }
        else {
            const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
            return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${context}`;
        }
    }
    createLogEntry(level, message, context) {
        return {
            level,
            message,
            timestamp: new Date().toISOString(),
            context
        };
    }
    shouldLog(level) {
        const levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        return levels[level] >= levels[this.config.level];
    }
    debug(message, context) {
        if (this.shouldLog('debug')) {
            const entry = this.createLogEntry('debug', message, context);
            console.error(this.formatLog(entry));
        }
    }
    info(message, context) {
        if (this.shouldLog('info')) {
            const entry = this.createLogEntry('info', message, context);
            console.error(this.formatLog(entry));
        }
    }
    warn(message, context) {
        if (this.shouldLog('warn')) {
            const entry = this.createLogEntry('warn', message, context);
            console.error(this.formatLog(entry));
        }
    }
    error(message, context) {
        if (this.shouldLog('error')) {
            const entry = this.createLogEntry('error', message, context);
            console.error(this.formatLog(entry));
        }
    }
    setLogLevel(level) {
        this.config.level = level;
    }
    setLogFormat(format) {
        this.config.format = format;
    }
}
export class ExecutorError extends Error {
    constructor(code, message, context) {
        super(message);
        this.code = code;
        this.context = context;
        this.name = 'ExecutorError';
    }
}
// Error codes
export const ErrorCode = {
    EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
    MEMORY_LIMIT_EXCEEDED: 'MEMORY_LIMIT_EXCEEDED',
    PYTHON_ERROR: 'PYTHON_ERROR',
    INVALID_INPUT: 'INVALID_INPUT',
    PACKAGE_INSTALLATION_ERROR: 'PACKAGE_INSTALLATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
};
