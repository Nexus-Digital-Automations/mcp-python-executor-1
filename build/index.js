#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode as McpErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import { PythonShell } from 'python-shell';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from './config.js';
import { metrics } from './metrics.js';
import { Logger, ExecutorError, ErrorCode } from './logger.js';
const execAsync = promisify(exec);
const isValidExecuteArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        typeof args.code === 'string' &&
        (args.inputData === undefined ||
            (Array.isArray(args.inputData) &&
                args.inputData.every((item) => typeof item === 'string'))));
};
const isValidInstallArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        Array.isArray(args.packages) &&
        args.packages.every((pkg) => typeof pkg === 'string'));
};
class PythonExecutorServer {
    constructor() {
        this.config = loadConfig();
        this.activeExecutions = 0;
        this.server = new Server({
            name: 'mcp-python-executor',
            version: '0.2.0', // Updated version
        });
        this.logger = new Logger(this.config.logging);
        // Create temp directory for script files
        this.tempDir = path.join(os.tmpdir(), 'python-executor');
        fs.mkdir(this.tempDir, { recursive: true }).catch((err) => this.logger.error('Failed to create temp directory', { error: err.message }));
        this.setupToolHandlers();
        this.initializePreinstalledPackages();
        // Error handling
        this.server.onerror = (error) => this.logger.error('MCP Error', { error });
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    async getPythonVersion() {
        try {
            const { stdout } = await execAsync('python --version');
            return stdout.trim();
        }
        catch (error) {
            this.logger.error('Failed to get Python version', { error });
            return 'unknown';
        }
    }
    async initializePreinstalledPackages() {
        const packages = Object.keys(this.config.python.packages);
        if (packages.length > 0) {
            try {
                this.logger.info('Installing pre-configured packages', { packages });
                await this.handleInstallPackages({ packages });
                this.logger.info('Pre-configured packages installed successfully');
            }
            catch (error) {
                this.logger.error('Error installing pre-configured packages', { error });
            }
        }
    }
    setupToolHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'execute_python',
                    description: 'Execute Python code and return the results',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            code: {
                                type: 'string',
                                description: 'Python code to execute',
                            },
                            inputData: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                },
                                description: 'Optional array of input strings for the script',
                            },
                        },
                        required: ['code'],
                    },
                },
                {
                    name: 'install_packages',
                    description: 'Install Python packages using pip',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            packages: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                },
                                description: 'Array of package names to install',
                            },
                        },
                        required: ['packages'],
                    },
                },
                {
                    name: 'health_check',
                    description: 'Check server health status and get metrics',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },
            ],
        }));
        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case 'execute_python':
                    return this.handleExecutePython(request.params.arguments);
                case 'install_packages':
                    return this.handleInstallPackages(request.params.arguments);
                case 'health_check':
                    return this.handleHealthCheck();
                default:
                    throw new McpError(McpErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async handleHealthCheck() {
        const pythonVersion = await this.getPythonVersion();
        const stats = metrics.getStats();
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        status: 'healthy',
                        version: '0.2.0', // Updated version
                        pythonVersion,
                        config: this.config,
                        metrics: stats,
                        activeExecutions: this.activeExecutions,
                    }, null, 2),
                },
            ],
        };
    }
    async handleExecutePython(args) {
        if (!isValidExecuteArgs(args)) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Invalid Python execution arguments');
        }
        if (this.activeExecutions >= this.config.execution.maxConcurrent) {
            throw new ExecutorError(ErrorCode.EXECUTION_TIMEOUT, 'Maximum concurrent executions reached');
        }
        const startTime = Date.now();
        this.activeExecutions++;
        try {
            // Create temporary script file
            const scriptPath = path.join(this.tempDir, `script_${Date.now()}.py`);
            await fs.writeFile(scriptPath, args.code);
            // Configure Python shell options
            const options = {
                mode: 'text',
                pythonPath: 'python',
                pythonOptions: ['-u'],
                scriptPath: this.tempDir,
                args: args.inputData || [],
            };
            // Execute with timeout
            const results = await Promise.race([
                new Promise((resolve, reject) => {
                    let pyshell = new PythonShell(path.basename(scriptPath), options);
                    const output = [];
                    pyshell.on('message', (message) => {
                        output.push(message);
                    });
                    pyshell.end((err) => {
                        if (err)
                            reject(err);
                        else
                            resolve(output);
                    });
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timeout')), this.config.execution.timeoutMs)),
            ]);
            // Clean up temporary file
            await fs.unlink(scriptPath).catch((err) => this.logger.error('Failed to clean up temp file', { error: err.message }));
            const endTime = Date.now();
            const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
            metrics.recordExecution({
                startTime,
                endTime,
                memoryUsageMb: memoryUsage,
                success: true,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: results.join('\n'),
                    },
                ],
            };
        }
        catch (error) {
            const endTime = Date.now();
            const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
            metrics.recordExecution({
                startTime,
                endTime,
                memoryUsageMb: memoryUsage,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Python execution error', { error: errorMessage });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing Python code: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
        finally {
            this.activeExecutions--;
        }
    }
    async handleInstallPackages(args) {
        if (!isValidInstallArgs(args)) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Invalid package installation arguments');
        }
        try {
            const packages = args.packages.join(' ');
            const { stdout, stderr } = await execAsync(`pip install ${packages}`);
            this.logger.info('Packages installed successfully', { packages: args.packages });
            return {
                content: [
                    {
                        type: 'text',
                        text: stdout + (stderr ? `\nWarnings/Errors:\n${stderr}` : ''),
                    },
                ],
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Package installation error', { error: errorMessage });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error installing packages: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        this.logger.info('Python Executor MCP server running on stdio');
    }
}
const server = new PythonExecutorServer();
server.run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
