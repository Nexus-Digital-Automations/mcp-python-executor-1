import { Config } from './config.js';

export interface LogEntry {
    level: 'debug' | 'info' | 'error' | 'warn';
    message: string;
    timestamp: string;
    context?: Record<string, unknown>;
}

export class Logger {
    private config: Config['logging'];

    constructor(config: Config['logging']) {
        this.config = config;
        if (this.shouldLog('info')) {
            const entry = this.createLogEntry('info', 'Logger instance created with config', config);
            process.stderr.write(this.formatLog(entry) + '\n');
        }
    }

    private formatLog(entry: LogEntry): string {
        const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
        return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${context}`;
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
        if (this.shouldLog('debug')) {
            const entry = this.createLogEntry('debug', message, context);
            process.stderr.write(this.formatLog(entry) + '\n');
        }
    }

    info(message: string, context?: Record<string, unknown>) {
        if (this.shouldLog('info')) {
            const entry = this.createLogEntry('info', message, context);
            process.stderr.write(this.formatLog(entry) + '\n');
        }
    }

    warn(message: string, context?: Record<string, unknown>) {
        if (this.shouldLog('warn')) {
            const entry = this.createLogEntry('warn', message, context);
            process.stderr.write(this.formatLog(entry) + '\n');
        }
    }

    error(message: string, context?: Record<string, unknown>) {
        if (this.shouldLog('error')) {
            const entry = this.createLogEntry('error', message, context);
            process.stderr.write(this.formatLog(entry) + '\n');
        }
    }

    setLogLevel(level: string) {
        this.config.level = level;
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
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];
