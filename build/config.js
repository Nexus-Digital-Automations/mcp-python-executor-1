import * as path from 'path';
import * as os from 'os';
;
export const defaultConfig = {
    python: {
        version: '3.x',
        minVersion: '3.0.0',
        packages: {
            'numpy': '*',
            'pandas': '*',
            'matplotlib': '*',
            'scikit-learn': '*'
        },
        useVirtualEnv: true,
        venvPath: path.join(os.homedir(), '.mcp-python-venv'),
        analysis: {
            enableSecurity: false,
            enableStyle: false,
            enableComplexity: false,
            maxComplexity: 10
        }
    },
    execution: {
        maxMemoryMb: 512,
        timeoutMs: 300000, // 5 minutes
        packageTimeoutMs: 600000, // 10 minutes
        maxConcurrent: 5,
        enableProfiling: false,
        saveHistory: false
    },
    logging: {
        level: 'info',
        format: 'json'
    },
    temp: {
        directory: path.join(os.homedir(), '.mcp-python-temp'),
        cleanupIntervalMs: 3600000, // 1 hour
        maxAgeMs: 86400000 // 24 hours
    },
    database: {
        path: path.join(os.homedir(), '.mcp-python-database'),
        maxHistoryItems: 100
    }
};
export function loadConfig() {
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
        }, {});
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
        config.logging.level = process.env.LOG_LEVEL;
    }
    if (process.env.LOG_FORMAT) {
        config.logging.format = process.env.LOG_FORMAT;
    }
    return config;
}
export class DependencyResolver {
    constructor() {
        this.cache = new Map();
    }
    async resolveDependencies(packages) {
        const graphs = [];
        for (const pkg of packages) {
            if (!this.cache.has(pkg)) {
                const deps = await this.getPipDependencies(pkg);
                this.cache.set(pkg, deps);
            }
            graphs.push(this.cache.get(pkg));
        }
        return this.optimizeDependencies(graphs);
    }
    async getPipDependencies(pkg) {
        // Use pip show to get package info
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        try {
            const { stdout } = await execAsync(`pip show ${pkg}`);
            // Parse pip output and build dependency tree
            return this.parsePipOutput(stdout);
        }
        catch (error) {
            throw new Error(`Failed to resolve dependencies for ${pkg}`);
        }
    }
    parsePipOutput(output) {
        // Parse pip show output and return dependency graph
        // Implementation details...
        return {};
    }
    optimizeDependencies(graphs) {
        // Optimize by removing duplicate dependencies
        // Implementation details...
        return graphs;
    }
}
