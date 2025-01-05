import * as path from 'path';
import * as os from 'os';

export interface ServerConfig {
    python: {
        version: string;
        minVersion: string;
        packages: Record<string, string>;
        useVirtualEnv: boolean;
        venvPath: string;
    };
    execution: {
        maxMemoryMb: number;
        timeoutMs: number;
        packageTimeoutMs: number;
        maxConcurrent: number;
    };
    logging: {
        level: 'debug' | 'info' | 'error';
        format: 'json' | 'text';
    };
    temp: {
        directory: string;
        cleanupIntervalMs: number;
        maxAgeMs: number;
    };
}

export const defaultConfig: ServerConfig = {
    python: {
        version: '3.x',
        minVersion: '3.9.0',
        packages: {
            'numpy': '*',
            'pandas': '*',
            'matplotlib': '*',
            'scikit-learn': '*'
        },
        useVirtualEnv: true,
        venvPath: path.join(os.homedir(), '.mcp-python-venv')
    },
    execution: {
        maxMemoryMb: 512,
        timeoutMs: 300000, // 5 minutes
        packageTimeoutMs: 600000, // 10 minutes
        maxConcurrent: 5
    },
    logging: {
        level: 'info',
        format: 'json'
    },
    temp: {
        directory: path.join(os.homedir(), '.mcp-python-temp'),
        cleanupIntervalMs: 3600000, // 1 hour
        maxAgeMs: 86400000 // 24 hours
    }
};

export function loadConfig(): ServerConfig {
    const config = { ...defaultConfig };

    // Override with environment variables if present
    if (process.env.PYTHON_VERSION) {
        config.python.version = process.env.PYTHON_VERSION;
    }

    if (process.env.PREINSTALLED_PACKAGES) {
        const packages = process.env.PREINSTALLED_PACKAGES.split(' ').filter(Boolean);
        config.python.packages = packages.reduce((acc, pkg) => {
            acc[pkg] = '*';
            return acc;
        }, {} as Record<string, string>);
    }

    if (process.env.MAX_MEMORY_MB) {
        config.execution.maxMemoryMb = parseInt(process.env.MAX_MEMORY_MB, 10);
    }

    if (process.env.EXECUTION_TIMEOUT_MS) {
        config.execution.timeoutMs = parseInt(process.env.EXECUTION_TIMEOUT_MS, 10);
    }

    if (process.env.MAX_CONCURRENT_EXECUTIONS) {
        config.execution.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_EXECUTIONS, 10);
    }

    if (process.env.LOG_LEVEL) {
        config.logging.level = process.env.LOG_LEVEL as 'debug' | 'info' | 'error';
    }

    if (process.env.LOG_FORMAT) {
        config.logging.format = process.env.LOG_FORMAT as 'json' | 'text';
    }

    return config;
}
