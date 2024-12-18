#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { PythonShell, Options } from 'python-shell';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ExecutePythonArgs {
  code: string;
  inputData?: string[];
}

interface InstallPackageArgs {
  packages: string[];
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

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-python-executor',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Create temp directory for script files
    this.tempDir = path.join(os.tmpdir(), 'python-executor');
    fs.mkdir(this.tempDir, { recursive: true }).catch(console.error);

    this.setupToolHandlers();
    this.initializePreinstalledPackages();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async initializePreinstalledPackages() {
    const preinstalledPackages = process.env.PREINSTALLED_PACKAGES;
    if (preinstalledPackages) {
      try {
        const packages = preinstalledPackages.split(' ').filter(Boolean);
        console.error('Installing pre-configured packages:', packages.join(', '));
        await this.handleInstallPackages({ packages });
        console.error('Pre-configured packages installed successfully');
      } catch (error) {
        console.error('Error installing pre-configured packages:', error);
      }
    }
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
      ],
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'execute_python':
          return this.handleExecutePython(request.params.arguments);
        case 'install_packages':
          return this.handleInstallPackages(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleExecutePython(args: unknown) {
    if (!isValidExecuteArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid Python execution arguments'
      );
    }

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
        pythonPath: 'python', // Uses system Python
        pythonOptions: ['-u'], // Unbuffered output
        scriptPath: this.tempDir,
        args: [],
      };

      if (args.inputData) {
        options.args = args.inputData;
      }

      // Execute the script and capture output
      const results = await new Promise<string[]>((resolve, reject) => {
        let pyshell = new PythonShell(path.basename(scriptPath), options);
        const output: string[] = [];

        pyshell.on('message', (message) => {
          output.push(message);
        });

        pyshell.end((err) => {
          if (err) reject(err);
          else resolve(output);
        });
      });

      // Clean up temporary file
      await fs.unlink(scriptPath).catch(console.error);

      return {
        content: [
          {
            type: 'text',
            text: results.join('\n'),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Python execution error:', errorMessage);
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
  }

  private async handleInstallPackages(args: unknown) {
    if (!isValidInstallArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid package installation arguments'
      );
    }

    try {
      const packages = args.packages.join(' ');
      const { stdout, stderr } = await execAsync(`pip install ${packages}`);

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
      console.error('Package installation error:', errorMessage);
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
    console.error('Python Executor MCP server running on stdio');
  }
}

const server = new PythonExecutorServer();
server.run().catch(console.error);
