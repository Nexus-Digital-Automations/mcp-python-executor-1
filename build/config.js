import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
export async function loadConfig() {
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
            packages: {}
        },
        execution: {
            timeoutMs: process.env.EXECUTION_TIMEOUT_MS ? parseInt(process.env.EXECUTION_TIMEOUT_MS, 10) : 30000,
            packageTimeoutMs: process.env.PACKAGE_TIMEOUT_MS ? parseInt(process.env.PACKAGE_TIMEOUT_MS, 10) : 300000
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
