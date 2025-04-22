import { ServerConfig } from './config.js';

export interface LogEntry {
    level: 'debug' | 'info' | 'error' | 'warn';
    message: string;
    timestamp: string;
    context?: Record<string, unknown>;
}

export class Logger {
    private config: ServerConfig['logging'];

    constructor(config: ServerConfig['logging']) {
        this.config = config;
        console.log("DIRECT_LOGGER: Logger instance created with config:", JSON.stringify(config));
    }

    private formatLog(entry: LogEntry): string {
        if (this.config.format === 'json') {
            return JSON.stringify(entry);
        } else {
            const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
            return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${context}`;
        }
    }

    private createLogEntry(
        level: LogEntry['level'],
        message: string,
        context?: Record<string, unknown>
    ): LogEntry {
        return {
            level,
            message,
            timestamp: new Date().toISOString(),
            context
        };
    }

    private shouldLog(level: LogEntry['level']): boolean {
        const levels: Record<string, number> = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        return levels[level] >= levels[this.config.level];
    }

    debug(message: string, context?: Record<string, unknown>) {
        console.log(`DIRECT_DEBUG: ${message} ${context ? JSON.stringify(context) : ''}`);
        if (this.shouldLog('debug')) {
            const entry = this.createLogEntry('debug', message, context);
            console.error(this.formatLog(entry));
        }
    }

    info(message: string, context?: Record<string, unknown>) {
        console.log(`DIRECT_INFO: ${message} ${context ? JSON.stringify(context) : ''}`);
        if (this.shouldLog('info')) {
            const entry = this.createLogEntry('info', message, context);
            console.error(this.formatLog(entry));
        }
    }

    warn(message: string, context?: Record<string, unknown>) {
        console.log(`DIRECT_WARN: ${message} ${context ? JSON.stringify(context) : ''}`);
        if (this.shouldLog('warn')) {
            const entry = this.createLogEntry('warn', message, context);
            console.error(this.formatLog(entry));
        }
    }

    error(message: string, context?: Record<string, unknown>) {
        console.log(`DIRECT_ERROR: ${message} ${context ? JSON.stringify(context) : ''}`);
        if (this.shouldLog('error')) {
            const entry = this.createLogEntry('error', message, context);
            console.error(this.formatLog(entry));
        }
    }

    setLogLevel(level: ServerConfig['logging']['level']) {
        this.config.level = level;
    }

    setLogFormat(format: ServerConfig['logging']['format']) {
        this.config.format = format;
    }
}

export class ExecutorError extends Error {
    constructor(
        public code: string,
        message: string,
        public context?: Record<string, unknown>
    ) {
        super(message);
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
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];
