import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

export interface ServerConfig {
    python: {
        version: string;
        minVersion: string;
        packages: Record<string, string>;
        useVirtualEnv: boolean;
        venvPath: string;
        analysis: {
            enableSecurity: boolean;
            enableStyle: boolean;
            enableComplexity: boolean;
            maxComplexity: number;
        };
    };
    execution: {
        maxMemoryMb: number;
        timeoutMs: number;
        packageTimeoutMs: number;
        maxConcurrent: number;
        enableProfiling: boolean;
        saveHistory: boolean;
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
    database: {
        path: string;
        maxHistoryItems: number;
    };
};


export const defaultConfig: ServerConfig = {
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
        level: 'debug',
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

    if (process.env.VENV_PATH) {
        config.python.venvPath = process.env.VENV_PATH;
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

// Add new file: src/dependencies.ts
export interface DependencyGraph {
    name: string;
    version: string;
    dependencies: DependencyGraph[];
}

export class DependencyResolver {
    private cache: Map<string, DependencyGraph> = new Map();

    async resolveDependencies(packages: string[]): Promise<DependencyGraph[]> {
        const graphs: DependencyGraph[] = [];

        for (const pkg of packages) {
            if (!this.cache.has(pkg)) {
                const deps = await this.getPipDependencies(pkg);
                this.cache.set(pkg, deps);
            }
            graphs.push(this.cache.get(pkg)!);
        }

        return this.optimizeDependencies(graphs);
    }

    private async getPipDependencies(pkg: string): Promise<DependencyGraph> {
        // Use pip show to get package info
        const execAsync = promisify(exec);

        try {
            const { stdout } = await execAsync(`pip show ${pkg}`);
            // Parse pip output and build dependency tree
            return this.parsePipOutput(stdout);
        } catch (error) {
            throw new Error(`Failed to resolve dependencies for ${pkg}`);
        }
    }

    private parsePipOutput(output: string): DependencyGraph {
        // Parse pip show output and return dependency graph
        // Implementation details...
        return {} as DependencyGraph;
    }

    private optimizeDependencies(graphs: DependencyGraph[]): DependencyGraph[] {
        // Optimize by removing duplicate dependencies
        // Implementation details...
        return graphs;
    }
}
