import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

export interface PythonConfig {
    venvsBasePath: string;
    defaultVenvName: string;
    minVersion: string;
    packages: Record<string, string>;
}

export interface ServerConfig {
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

export async function loadConfig(): Promise<ServerConfig> {
    // Define default base path for virtual environments
    const defaultVenvsBasePath = path.join(os.homedir(), '.python-executor', 'venvs');
    
    // Ensure the venvsBasePath directory exists
    const venvsBasePath = process.env.VENVS_BASE_PATH || defaultVenvsBasePath;
    await fs.mkdir(venvsBasePath, { recursive: true })
        .catch(err => {
            console.error(`WARNING: Failed to create venvsBasePath directory at ${venvsBasePath}: ${err.message}`);
        });
    
    return {
        python: {
            venvsBasePath,
            defaultVenvName: process.env.DEFAULT_VENV_NAME || 'default',
            minVersion: '3.8.0',
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
