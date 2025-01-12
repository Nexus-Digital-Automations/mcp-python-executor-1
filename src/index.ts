#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode as McpErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { PythonShell, Options } from 'python-shell';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from './config.js';
import { metrics } from './metrics.js';
import { Logger, ExecutorError, ErrorCode } from './logger.js';

const execAsync = promisify(exec);

interface ExecutePythonArgs {
  code: string;
  inputData?: string[];
}

interface InstallPackageArgs {
  packages: string[];
}

interface Prompt {
  name: string;
  description: string;
  arguments: {
    name: string;
    description: string;
    required: boolean;
  }[];
}

const isValidExecuteArgs = (args: any): args is ExecutePythonArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.code === 'string' &&
    (args.inputData === undefined ||
      (Array.isArray(args.inputData) &&
        args.inputData.every((item: any) => typeof item === 'string')))
  );
};

const isValidInstallArgs = (args: any): args is InstallPackageArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    Array.isArray(args.packages) &&
    args.packages.every((pkg: any) => typeof pkg === 'string')
  );
};

class PythonExecutorServer {
  private server: Server;
  private tempDir: string;
  private venvDir: string;
  private config = loadConfig();
  private logger: Logger;
  private activeExecutions = 0;
  private cleanupInterval: NodeJS.Timeout;

  // Define available prompts with type safety
  private PROMPTS: Record<string, Prompt> = {
    'execute-python': {
      name: 'execute-python',
      description: 'Execute Python code with best practices and error handling',
      arguments: [
        {
          name: 'task',
          description: 'Description of what the code should do',
          required: true
        },
        {
          name: 'requirements',
          description: 'Any specific requirements or constraints',
          required: false
        }
      ]
    },
    'debug-python': {
      name: 'debug-python',
      description: 'Debug Python code execution issues',
      arguments: [
        {
          name: 'code',
          description: 'Code that produced the error',
          required: true
        },
        {
          name: 'error',
          description: 'Error message received',
          required: true
        }
      ]
    },
    'install-packages': {
      name: 'install-packages',
      description: 'Guide for safely installing Python packages',
      arguments: [
        {
          name: 'packages',
          description: 'List of packages to install',
          required: true
        },
        {
          name: 'purpose',
          description: 'What the packages will be used for',
          required: false
        }
      ]
    }
  };

  constructor() {
    this.server = new Server({
      name: 'mcp-python-executor',
      version: '0.2.0',
      capabilities: {
        prompts: {}
      }
    });
    this.venvDir = this.config.python.venvPath;
    this.cleanupInterval = setInterval(
      () => this.cleanupTempFiles(),
      this.config.temp.cleanupIntervalMs
    );

    this.logger = new Logger(this.config.logging);
    this.setupPromptHandlers();

    // Create temp directory for script files
    this.tempDir = path.join(os.tmpdir(), 'python-executor');
    fs.mkdir(this.tempDir, { recursive: true }).catch(
      (err) => this.logger.error('Failed to create temp directory', { error: err.message })
    );

    this.setupToolHandlers();
    this.initializePreinstalledPackages();

    // Error handling
    this.server.onerror = (error) => this.logger.error('MCP Error', { error });
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async getPythonVersion(): Promise<string> {
    try {
      const { stdout } = await execAsync('python --version');
      return stdout.trim();
    } catch (error) {
      this.logger.error('Failed to get Python version', { error });
      return 'unknown';
    }
  }

  private async initializePreinstalledPackages() {
    const packages = Object.keys(this.config.python.packages);
    if (packages.length > 0) {
      try {
        this.logger.info('Installing pre-configured packages', { packages });
        await this.handleInstallPackages({ packages });
        this.logger.info('Pre-configured packages installed successfully');
      } catch (error) {
        this.logger.error('Error installing pre-configured packages', { error });
      }
    }
  }

  private setupPromptHandlers() {
    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: Object.values(this.PROMPTS)
    }));

    // Get specific prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = this.PROMPTS[request.params.name];
      if (!prompt) {
        throw new McpError(McpErrorCode.InvalidRequest, `Prompt not found: ${request.params.name}`);
      }

      if (request.params.name === 'execute-python') {
        const task = request.params.arguments?.task || '';
        const requirements = request.params.arguments?.requirements || '';
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Task: ${task}\nRequirements: ${requirements}\n\nPlease help me write Python code that:`
                  + '\n1. Is efficient and follows PEP 8 style guidelines'
                  + '\n2. Includes proper error handling'
                  + '\n3. Has clear comments explaining the logic'
                  + '\n4. Uses appropriate Python features and standard library modules'
              }
            }
          ]
        };
      }

      if (request.params.name === 'debug-python') {
        const code = request.params.arguments?.code || '';
        const error = request.params.arguments?.error || '';
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Let's debug this Python code:\n\n${code}\n\nError:\n${error}\n\nLet's analyze:`
                  + '\n1. The specific error message and line number'
                  + '\n2. Common causes for this type of error'
                  + '\n3. Potential fixes and improvements'
                  + '\n4. Best practices to prevent similar issues'
              }
            }
          ]
        };
      }

      if (request.params.name === 'install-packages') {
        const packages = request.params.arguments?.packages || '';
        const purpose = request.params.arguments?.purpose || '';
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Installing packages: ${packages}\nPurpose: ${purpose}\n\nLet's ensure safe installation:`
                  + '\n1. Verify package names and versions'
                  + '\n2. Check for potential conflicts'
                  + '\n3. Consider security implications'
                  + '\n4. Recommend virtual environment usage if appropriate'
                  + '\n5. Suggest alternative packages if relevant'
              }
            }
          ]
        };
      }

      throw new McpError(McpErrorCode.InvalidRequest, 'Prompt implementation not found');
    });
  }

  private setupToolHandlers() {
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
          throw new McpError(
            McpErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleHealthCheck() {
    const pythonVersion = await this.getPythonVersion();
    const stats = metrics.getStats();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'healthy',
            version: '0.2.0',
            pythonVersion,
            config: this.config,
            metrics: stats,
            activeExecutions: this.activeExecutions,
          }, null, 2),
        },
      ],
    };
  }

  private async handleExecutePython(args: unknown) {
    if (!isValidExecuteArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Invalid Python execution arguments'
      );
    }

    if (this.activeExecutions >= this.config.execution.maxConcurrent) {
      throw new ExecutorError(
        ErrorCode.EXECUTION_TIMEOUT,
        'Maximum concurrent executions reached'
      );
    }

    const startTime = Date.now();
    this.activeExecutions++;

    try {
      // Create temporary script file
      const scriptPath = path.join(
        this.tempDir,
        `script_${Date.now()}.py`
      );
      await fs.writeFile(scriptPath, args.code);

      // Configure Python shell options
      const options: Options = {
        mode: 'text',
        pythonPath: 'python',
        pythonOptions: ['-u'],
        scriptPath: this.tempDir,
        args: args.inputData || [],
      };

      // Execute with timeout
      const results = await Promise.race([
        new Promise<string[]>((resolve, reject) => {
          let pyshell = new PythonShell(path.basename(scriptPath), options);
          const output: string[] = [];

          pyshell.on('message', (message) => {
            output.push(message);
          });

          pyshell.end((err) => {
            if (err) reject(err);
            else resolve(output);
          });
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Execution timeout')), this.config.execution.timeoutMs)
        ),
      ]);

      // Clean up temporary file
      await fs.unlink(scriptPath).catch(
        (err) => this.logger.error('Failed to clean up temp file', { error: err.message })
      );

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
    } catch (error: unknown) {
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
    } finally {
      this.activeExecutions--;
    }
  }

  private async cleanupTempFiles(): Promise<void> {
    try {
      const now = Date.now();
      const files = await fs.readdir(this.tempDir);

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = await fs.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > this.config.temp.maxAgeMs) {
          await fs.unlink(filePath).catch(err =>
            this.logger.error('Failed to delete temp file', { file, error: err.message })
          );
        }
      }
    } catch (error) {
      this.logger.error('Error during temp file cleanup', { error });
    }
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    this.logger.info('Comparing versions', {
      v1,
      v2,
      parts1,
      parts2
    });

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      this.logger.info('Comparing parts', {
        index: i,
        part1,
        part2
      });

      if (part1 !== part2) {
        const result = part1 - part2;
        this.logger.info('Version comparison result', { result });
        return result;
      }
    }
    return 0;
  }

  private async verifyPythonVersion(): Promise<void> {
    const { stdout } = await execAsync('python --version');
    this.logger.info('Python version output', { stdout });

    const versionMatch = stdout.match(/Python (\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      throw new Error('Could not determine Python version');
    }

    const installedVersion = versionMatch[1];
    const minVersion = this.config.python.minVersion;

    this.logger.info('Version check', {
      installedVersion,
      minVersion,
      config: this.config.python
    });

    const comparison = this.compareVersions(installedVersion, minVersion);
    this.logger.info('Version comparison', { comparison });

    if (comparison < 0) {
      throw new Error(`Python version ${installedVersion} is below required minimum ${minVersion}`);
    }
    this.logger.info('Python version verified', { installed: installedVersion, minimum: minVersion });
  }

  private async setupVirtualEnvironment(): Promise<void> {
    if (!this.config.python.useVirtualEnv) return;

    try {
      // Check if virtual environment already exists
      const venvExists = await fs.access(this.venvDir)
        .then(() => true)
        .catch(() => false);

      if (!venvExists) {
        await execAsync(`python -m venv ${this.venvDir}`);
        this.logger.info('Created virtual environment', { path: this.venvDir });
      }
    } catch (error) {
      this.logger.error('Failed to setup virtual environment', { error });
      throw error;
    }
  }

  private async handleInstallPackages(args: unknown) {
    if (!isValidInstallArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Invalid package installation arguments'
      );
    }

    try {
      // Verify Python version
      await this.verifyPythonVersion();

      // Setup virtual environment if enabled
      await this.setupVirtualEnvironment();

      // Install packages with appropriate pip command
      const packages = args.packages.join(' ');
      const pipCommand = this.config.python.useVirtualEnv
        ? `${path.join(this.venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip')} install ${packages}`
        : `pip install ${packages}`;

      const { stdout, stderr } = await execAsync(pipCommand, {
        timeout: this.config.execution.packageTimeoutMs
      });

      this.logger.info('Packages installed successfully', { packages: args.packages });

      return {
        content: [
          {
            type: 'text',
            text: stdout + (stderr ? `\nWarnings/Errors:\n${stderr}` : ''),
          },
        ],
      };
    } catch (error: unknown) {
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
