import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

export interface PythonConfig {
    venvPath: string;
    minVersion: string;
    useVirtualEnv: boolean;
    packages: Record<string, string>;
}

export interface Config {
    python: PythonConfig;
    execution: {
        timeoutMs: number;
        packageTimeoutMs: number;
    };
    temp: {
        cleanupIntervalMs: number;
        maxAgeMs: number;
    };
    logging: {
        level: string;
        file?: string;
    };
}

export function loadConfig(): Config {
    return {
        python: {
            venvPath: process.env.PYTHON_VENV_PATH || path.join(os.homedir(), '.python-executor', 'venv'),
            minVersion: '3.8.0',
            useVirtualEnv: true,
            packages: {
                'numpy': '>=1.20.0',
                'pandas': '>=1.3.0',
                'matplotlib': '>=3.4.0',
                'scikit-learn': '>=0.24.0',
                'requests': '>=2.25.0',
                'beautifulsoup4': '>=4.9.0',
            }
        },
        execution: {
            timeoutMs: process.env.EXECUTION_TIMEOUT_MS ? parseInt(process.env.EXECUTION_TIMEOUT_MS, 10) : 3000000,
            packageTimeoutMs: process.env.PACKAGE_TIMEOUT_MS ? parseInt(process.env.PACKAGE_TIMEOUT_MS, 10) : 30000000
        },
        temp: {
            cleanupIntervalMs: 3600000,
            maxAgeMs: 86400000
        },
        logging: {
            level: process.env.LOG_LEVEL || 'info',
            file: process.env.LOG_FILE
        }
    };
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
