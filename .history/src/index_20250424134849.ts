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
import { loadConfig, ServerConfig } from './config.js';
import { metrics } from './metrics.js';
import { Logger, ExecutorError, ErrorCode } from './logger.js';
import { VenvManager } from './venvUtils.js';

// Add direct console logging at the very beginning
console.error("STARTUP: Beginning process initialization");
process.on('uncaughtException', (err) => {
  console.error(`CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(`CRITICAL UNHANDLED REJECTION: ${reason}`);
  process.exit(1);
});

const execAsync = promisify(exec);

interface ExecutePythonArgs {
  code?: string;
  scriptPath?: string;
  inputData?: string[];
  venvName?: string;
}

interface InstallPackageArgs {
  packages: string | string[];
  venvName?: string;
}

interface VenvArgs {
  venvName: string;
  description?: string;
  confirm?: boolean;
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
    (typeof args.code === 'string' || typeof args.scriptPath === 'string') &&
    (args.inputData === undefined ||
      (Array.isArray(args.inputData) &&
        args.inputData.every((item: any) => typeof item === 'string'))) &&
    (args.venvName === undefined || typeof args.venvName === 'string')
  );
};

const isValidInstallArgs = (args: any): args is InstallPackageArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.packages === 'string' ||
      (Array.isArray(args.packages) &&
        args.packages.every((pkg: any) => typeof pkg === 'string'))) &&
    (args.venvName === undefined || typeof args.venvName === 'string')
  );
};

const isValidVenvArgs = (args: any): args is VenvArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.venvName === 'string' &&
    (args.description === undefined || typeof args.description === 'string') &&
    (args.confirm === undefined || typeof args.confirm === 'boolean')
  );
};

class PythonExecutorServer {
  private server: Server;
  private tempDir: string;
  private config!: ServerConfig; // Using definite assignment assertion
  public logger: Logger;
  private activeExecutions = 0;
  private cleanupInterval: NodeJS.Timeout;
  private venvManager!: VenvManager; // Using definite assignment assertion

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
    console.error("STARTUP: Beginning server construction");
    
    try {
      this.server = new Server({
        name: 'mcp-python-executor',
        version: '0.2.0',
        capabilities: {
          prompts: {},
          tools: {}
        }
      });
      console.error("STARTUP: Created server instance");

      // Load config synchronously for constructor initialization
      const tempConfig = loadConfig();
      this.config = tempConfig instanceof Promise ? {} as ServerConfig : tempConfig;
      
      this.cleanupInterval = setInterval(
        () => this.cleanupTempFiles(),
        this.config.temp?.cleanupIntervalMs || 3600000
      );
      console.error("STARTUP: Set up cleanup interval");

      this.logger = new Logger(this.config.logging || { level: 'info' });
      console.error("STARTUP: Created logger");

      // Now that logger is initialized, we can use it for the remaining logs
      
      // Create temp directory for script files
      this.tempDir = path.join(os.tmpdir(), 'python-executor');
      this.logger.info(`Setting temp directory to ${this.tempDir}`);
      fs.mkdir(this.tempDir, { recursive: true }).catch(
        (err) => this.logger.error(`Failed to create temp directory: ${err.message}`)
      );

      this.logger.info("Setting up handlers");
      this.setupPromptHandlers();
      this.setupToolHandlers();
      
      // Initialize preinstalled packages
      this.initializePreinstalledPackages();
      this.logger.info("Initializing preinstalled packages");

      // Error handling
      this.server.onerror = (error) => {
        this.logger.error('MCP Error', { error });
      };
      process.on('SIGINT', async () => {
        await this.server.close();
        process.exit(0);
      });
      
      this.logger.info("Server construction completed successfully");
    } catch (error) {
      console.error(`CRITICAL STARTUP ERROR: ${error instanceof Error ? error.message : String(error)}`);
      console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
      throw error;
    }
    
    // Test the virtual environment setup after run() initializes the venvManager
    this.testVirtualEnvironment().catch(err => {
      console.error(`Failed to test virtual environment: ${err instanceof Error ? err.message : String(err)}`);
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

  /**
   * Initialize the default virtual environment with pre-configured packages
   */
  private async initializePreinstalledPackages() {
    const packages = Object.keys(this.config.python.packages);
    if (packages.length > 0) {
      try {
        this.logger.info('Installing pre-configured packages in virtual environment', { 
          packages
        });
        
        // Install packages in the environment
        await this.handleInstallPackages({ 
          packages
        });
        
        this.logger.info('Pre-configured packages installed successfully in virtual environment');
      } catch (error) {
        this.logger.error('Error installing pre-configured packages', { 
          error: error instanceof Error ? error.message : String(error) 
        });
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
                text: `Task: ${task}\nRequirements: ${requirements}\n\n⚠️ CRITICAL DEPENDENCY WARNING ⚠️\n\nBEFORE executing ANY Python code, you MUST:\n1. Check installed packages using 'list_packages' tool\n2. Install missing dependencies using 'install_packages' tool\n3. ONLY then use 'execute_python'\n\n⚠️ NEVER SKIP THIS WORKFLOW. Module not found errors are almost always caused by missing dependencies!\n\nPlease help me write Python code that:`
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
                  + '\n4. Suggest alternative packages if relevant'
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
          description: `⚠️ CRITICAL DEPENDENCY WARNING ⚠️
DO NOT USE THIS TOOL FIRST! ALWAYS CHECK AND INSTALL DEPENDENCIES FIRST!

Follow this exact workflow:
1. FIRST use 'list_packages' to check dependencies
2. THEN use 'install_packages' to install missing dependencies
3. ONLY AFTER DEPENDENCIES ARE INSTALLED use execute_python

Execute Python code in a secure, isolated environment with configurable resource limits.

⚠️ COMMON ERROR: "Module not found" errors occur when dependencies are not installed!
⚠️ CRITICAL: NEVER run execute_python without verifying dependencies first!
⚠️ ALWAYS install required packages BEFORE running this tool!

Features:
- Automatic virtual environment management
- Resource monitoring (memory, CPU)
- Input/output stream handling
- Error handling and timeout protection
- Support for both inline code and existing script files

CORRECT WORKFLOW:
1. FIRST check if required packages are installed using list_packages
2. If needed, install required packages using install_packages
3. THEN write your Python code with proper error handling
4. ONLY AFTER STEPS 1-3 call execute_python with your code

Example usage with inline code:
{
  "code": "import numpy as np\\ntry:\\n    data = np.random.rand(3,3)\\n    print(data)\\nexcept Exception as e:\\n    print(f'Error: {e}')",
  "inputData": ["optional", "input", "strings"],
  "venvName": "data-science"
}

Example usage with a script file:
{
  "scriptPath": "/path/to/your/script.py",
  "inputData": ["optional", "input", "strings"],
  "venvName": "web-scraping"
}`,
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to execute. Can include multiple lines and import statements.',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to an existing Python script file to execute instead of inline code.',
              },
              inputData: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional array of input strings that will be available to the script via stdin',
              },
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to use for execution. Defaults to the configured default venv.'
              }
            },
            required: [],
          },
        },
        {
          name: 'install_packages',
          description: `Install Python packages using uv (faster alternative to pip) with dependency resolution.

Features:
- Automatic virtual environment detection
- Version compatibility checking
- Dependency conflict resolution
- Security vulnerability scanning
- Installation status monitoring

Example usage:
{
  "packages": "numpy>=1.20.0, pandas, matplotlib",
  "venvName": "data-science"
}

or with array format:
{
  "packages": ["numpy>=1.20.0", "pandas", "matplotlib"],
  "venvName": "web-scraping"
}`,
          inputSchema: {
            type: 'object',
            properties: {
              packages: {
                oneOf: [
                  {
                    type: 'string',
                    description: 'Comma-separated list of package specifications (e.g. "numpy>=1.20.0, pandas")',
                  },
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'Array of package specifications. Can include version constraints (e.g. "numpy>=1.20.0")',
                  }
                ]
              },
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to install packages into. Defaults to the configured default venv.'
              }
            },
            required: ['packages'],
          },
        },
        {
          name: 'health_check',
          description: `Get detailed server health metrics and configuration status.

Returns:
- Python environment details
- Resource usage statistics
- Active executions count
- Configuration settings
- Package installation status

Example workflow:
1. Call health_check before starting work
2. Monitor during long-running operations
3. Verify after environment changes
4. Check when errors occur

Example usage:
{}  // No parameters required

Common workflows:
1. Initial setup verification:
   - Check Python version
   - Verify environment
   - List installed packages

2. Performance monitoring:
   - Track memory usage
   - Monitor CPU load
   - Check active executions

3. Troubleshooting:
   - Get error details
   - Check resource limits
   - Verify configurations`,
          inputSchema: {
            type: 'object',
            properties: {
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to check. If provided, returns details specific to this environment.'
              }
            },
            required: [],
          },
        },
        {
          name: 'list_packages',
          description: `List all installed packages in the virtual environment.

Features:
- Lists all installed Python packages with their versions
- Shows package dependencies
- Provides detailed package information

Example usage:
{
  "venvName": "data-science"  // Optional - defaults to default venv
}

Common workflows:
1. Installation verification:
   - Install packages
   - List to verify versions
   - Check dependencies

2. Environment inspection:
   - List all packages
   - Check versions
   - Identify outdated packages

3. Dependency management:
   - Review installed packages
   - Check version conflicts
   - Verify requirements`,
          inputSchema: {
            type: 'object',
            properties: {
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to list packages from. Defaults to the configured default venv.'
              }
            },
            required: [],
          },
        },
        {
          name: 'uninstall_packages',
          description: `Safely uninstall Python packages from the virtual environment.

Features:
- Safe dependency handling
- Verification of uninstallation
- Detailed status reporting

Example workflow:
1. Check health_check to verify environment state
2. Prepare list of packages to uninstall
3. Call uninstall_packages with package list
4. Verify uninstallation with list_packages

Example usage:
{
  "packages": "numpy,pandas,matplotlib",
  "venvName": "old-project"
}

or with array format:
{
  "packages": ["numpy", "pandas", "matplotlib"],
  "venvName": "old-project"
}

Common workflows:
1. Cleanup environment:
   - List installed packages
   - Remove unnecessary packages
   - Verify removal

2. Dependency management:
   - Remove conflicting packages
   - Clean up old versions
   - Verify dependencies

3. Environment maintenance:
   - Remove outdated packages
   - Clean up test packages
   - Verify environment state`,
          inputSchema: {
            type: 'object',
            properties: {
              packages: {
                oneOf: [
                  {
                    type: 'string',
                    description: 'Comma-separated list of packages to uninstall',
                  },
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'Array of package names to uninstall',
                  }
                ]
              },
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to uninstall packages from. Defaults to the configured default venv.'
              }
            },
            required: ['packages'],
          },
        },
        {
          name: 'list_venvs',
          description: `List all available Python virtual environments.

Features:
- Shows names, paths, and descriptions of all venvs
- Indicates the default environment
- Reports package counts for each environment

Example usage:
{}  // No parameters required`,
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'create_venv',
          description: `Create a new Python virtual environment.

Features:
- Creates isolated environment for Python dependencies
- Prevents package conflicts between projects
- Supports optional description for the environment

Example usage:
{
  "venvName": "data-science",
  "description": "Environment for data science projects with numpy and pandas"
}`,
          inputSchema: {
            type: 'object',
            properties: {
              venvName: {
                type: 'string',
                description: 'Name for the new virtual environment',
              },
              description: {
                type: 'string',
                description: 'Optional description of the virtual environment purpose',
              }
            },
            required: ['venvName'],
          },
        },
        {
          name: 'delete_venv',
          description: `Delete an existing Python virtual environment.

Features:
- Safely removes environment and all installed packages
- Confirmation required for default environment
- Cleans up all associated resources

Example usage:
{
  "venvName": "old-project",
  "confirm": false
}`,
          inputSchema: {
            type: 'object',
            properties: {
              venvName: {
                type: 'string',
                description: 'Name of the virtual environment to delete',
              },
              confirm: {
                type: 'boolean',
                description: 'Set to true to confirm deletion of the default environment',
              }
            },
            required: ['venvName'],
          },
        },
        {
          name: 'set_venv_description',
          description: `Set or update the description for a virtual environment.

Features:
- Adds metadata to describe the environment's purpose
- Helps organize and document different environments
- Makes environments more self-documenting

Example usage:
{
  "venvName": "web-scraping",
  "description": "Environment for web scraping projects with requests and beautifulsoup4"
}`,
          inputSchema: {
            type: 'object',
            properties: {
              venvName: {
                type: 'string',
                description: 'Name of the virtual environment',
              },
              description: {
                type: 'string',
                description: 'Description of the virtual environment purpose',
              }
            },
            required: ['venvName', 'description'],
          },
        },
        {
          name: 'analyze_code',
          description: `Analyze Python code for errors, security issues, and quality problems.

Features:
- Static code analysis
- Security vulnerability checking
- Code quality evaluation
- Performance analysis
- Best practices recommendations

Example usage:
{
  "code": "def my_function():\\n    print('Hello, World!')",
  "venvName": "data-science"
}

Common workflows:
1. Before execution:
   - Analyze code
   - Fix security issues
   - Improve performance
   - Follow best practices

2. After errors:
   - Analyze code
   - Find potential issues
   - Fix problems
   - Re-run execution

3. Code review:
   - Check for quality issues
   - Verify security
   - Improve maintainability`,
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to analyze'
              },
              venvName: {
                type: 'string',
                description: 'Optional virtual environment name to use for analysis. Defaults to the configured default venv.'
              }
            },
            required: ['code'],
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
          return this.handleHealthCheck(request.params.arguments);
        case 'uninstall_packages':
          return this.handleUninstallPackages(request.params.arguments);
        case 'list_packages':
          return this.handleListPackages(request.params.arguments);
        case 'list_venvs':
          return this.handleListVenvs();
        case 'create_venv':
          return this.handleCreateVenv(request.params.arguments);
        case 'delete_venv':
          return this.handleDeleteVenv(request.params.arguments);
        case 'set_venv_description':
          return this.handleSetVenvDescription(request.params.arguments);
        case 'analyze_code':
          return this.handleAnalyzeCode(request.params.arguments);
        default:
          throw new McpError(
            McpErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async getInstalledPackages(venvName?: string): Promise<Record<string, string>> {
    try {
      // Create a temporary Python script to list packages
      const scriptPath = path.join(
        this.tempDir,
        `list_packages_${Date.now()}.py`
      );

      // Script to list all installed packages with their versions
      // Using importlib.metadata which is more reliable than pkg_resources
      const pythonScript = `
import json
import sys

try:
    # Try using importlib.metadata (Python 3.8+) 
    try:
        import importlib.metadata as importlib_metadata
    except ImportError:
        # Fallback for older Python versions
        import importlib_metadata

    packages = {}
    for dist in importlib_metadata.distributions():
        packages[dist.metadata['Name'].lower()] = dist.version
    
    # Print as JSON for easy parsing
    print(json.dumps(packages))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
`;

      await fs.writeFile(scriptPath, pythonScript);
      this.logger.info('Created package listing script', { scriptPath });

      // Check if the virtual environment exists
      const venvExists = await this.checkVenvExists(venvName);
      if (!venvExists) {
        const targetVenvName = venvName || this.config.python.defaultVenvName;
        this.logger.warn('Attempted to get packages from non-existent venv', { venvName: targetVenvName });
        throw new ExecutorError(ErrorCode.INVALID_INPUT, `Virtual environment does not exist: ${targetVenvName}`);
      }

      // Get activation prefix for the virtual environment
      const { activateCmd, isWindows, pythonExecutable } = this.getActivationPrefix(venvName);

      // Use the Python executable from the virtual environment
      let command: string;
      if (isWindows) {
        // For Windows, we use cmd.exe to handle the activation
        command = `${activateCmd}python "${scriptPath}"`;
      } else {
        // For Unix, we can directly use the Python executable from the venv
        command = `${pythonExecutable} "${scriptPath}"`;
      }

      process.stderr.write(`DIRECT_DEBUG: Executing with command: ${command}\n`);

      // Execute the command with appropriate options
      const execOptions = {
        timeout: this.config.execution.packageTimeoutMs,
        env: { ...process.env },
        ...(isWindows ? { shell: 'cmd.exe' } : {})
      };

      const { stdout, stderr } = await execAsync(command, execOptions);

      // Clean up temporary file
      await fs.unlink(scriptPath).catch(
        err => this.logger.error('Failed to clean up package listing script', { error: err.message })
      );

      if (stderr) {
        this.logger.info('Stderr while getting packages', { stderr });
      }

      try {
        // Parse the JSON output
        const packagesRecord = JSON.parse(stdout);

        // Add debug log to see what packages were found
        this.logger.info('Successfully retrieved installed packages', {
          packageCount: Object.keys(packagesRecord).length,
          packages: Object.keys(packagesRecord).join(', ')
        });

        return packagesRecord;
      } catch (parseError) {
        this.logger.error('Failed to parse package list output', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          stdout
        });
        return {};
      }
    } catch (error) {
      this.logger.error('Failed to get installed packages', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return {}; // Return empty object in case of error
    }
  }

  /**
   * Handle list_venvs tool - lists all available virtual environments
   */
  private async handleListVenvs() {
    try {
      const venvDetails = await this.venvManager.getVenvDetails();
      this.logger.info('Listed venvs', { count: venvDetails.length });
      
      return { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ venvs: venvDetails }, null, 2), 
          mediaType: 'application/json' 
        }] 
      };
    } catch (error: any) {
      const message = `Failed to list venvs: ${error.message}`;
      this.logger.error(message, { error });
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: message, venvs: [] }, null, 2),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  /**
   * Tool handler for create_venv command - creates a new virtual environment
   * 
   * @param args - Arguments containing venvName and optional description
   * @returns Success/error response with details
   */
  private async handleCreateVenv(args: any) {
    if (!isValidVenvArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT, 
        'Missing or invalid venvName argument. Please provide a name for the virtual environment.'
      );
    }

    const { venvName, description } = args;
    
    try {
      // Create the virtual environment
      await this.venvManager.setupVirtualEnvironment(venvName);
      const venvPath = this.venvManager.getVenvPath(venvName);
      
      // Set description if provided
      if (description) {
        await this.venvManager.setVenvDescription(venvName, description);
      }
      
      // Return success response
      return { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            status: 'created', 
            message: `Successfully created virtual environment '${venvName}'`, 
            venvName, 
            path: venvPath,
            description: description || ''
          }, null, 2), 
          mediaType: 'application/json' 
        }] 
      };
    } catch (error: any) {
      this.logger.error('Failed to create virtual environment', { 
        venvName, 
        error: error.message || String(error) 
      });
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error', 
            message: `Failed to create virtual environment '${venvName}': ${error.message || 'Unknown error'}`, 
            venvName
          }, null, 2),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  /**
   * Tool handler for delete_venv command - safely deletes an existing virtual environment
   * 
   * @param args - Arguments containing venvName and optional confirm flag
   * @returns Success/error response with details
   */
  private async handleDeleteVenv(args: any) {
    if (!isValidVenvArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT, 
        'Missing or invalid venvName argument. Please provide the name of the virtual environment to delete.'
      );
    }
    
    const { venvName, confirm } = args;
    
    try {
      // Delete the virtual environment
      await this.venvManager.deleteVenv(venvName, confirm === true);
      
      // Return success response
      return { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            status: 'deleted', 
            message: `Successfully deleted virtual environment '${venvName}'`, 
            venvName
          }, null, 2), 
          mediaType: 'application/json' 
        }] 
      };
    } catch (error: any) {
      // If asking for confirmation for default venv
      if (error.message?.includes('without force=true')) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'confirmation_required',
              message: `'${venvName}' is the default virtual environment. To delete it, set confirm=true.`,
              venvName
            }, null, 2),
            mediaType: 'application/json'
          }],
          isError: false
        };
      }
      
      this.logger.error('Failed to delete virtual environment', { 
        venvName, 
        error: error.message || String(error) 
      });
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error', 
            message: `Failed to delete virtual environment '${venvName}': ${error.message || 'Unknown error'}`, 
            venvName
          }, null, 2),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  /**
   * Tool handler for set_venv_description command - updates the description of a virtual environment
   * 
   * @param args - Arguments containing venvName and description
   * @returns Success/error response with details
   */
  private async handleSetVenvDescription(args: any) {
    if (!isValidVenvArgs(args) || !args.description) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT, 
        'Missing or invalid arguments. Please provide venvName and description.'
      );
    }
    
    const { venvName, description } = args;
    
    try {
      // Update the description
      await this.venvManager.setVenvDescription(venvName, description);
      
      // Return success response
      return { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            status: 'updated', 
            message: `Successfully updated description for '${venvName}'`, 
            venvName,
            description
          }, null, 2), 
          mediaType: 'application/json' 
        }] 
      };
    } catch (error: any) {
      this.logger.error('Failed to update venv description', { 
        venvName, 
        error: error.message || String(error) 
      });
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error', 
            message: `Failed to update description for '${venvName}': ${error.message || 'Unknown error'}`, 
            venvName
          }, null, 2),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  private async handleExecutePython(args: unknown): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    if (!isValidExecuteArgs(args)) {
      throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid code or scriptPath. Please provide either code or scriptPath parameter.');
    }
    
    // Extract venvName from args
    const venvName = args.venvName;
    
    try {
      // Verify the environment exists
      const venvExists = await this.checkVenvExists(venvName);
      if (!venvExists) {
        const targetVenvName = venvName || this.config.python.defaultVenvName;
        throw new ExecutorError(
          ErrorCode.INTERNAL_ERROR, 
          `Virtual environment does not exist: ${targetVenvName}`
        );
      }
      
      // Use the venvManager to perform the operation with the specified venv
      if (venvName) {
        this.logger.info('Using specified virtual environment', { venvName });
      }
      
      // Return not implemented until we complete the real logic
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'not_implemented',
              message: 'Execute Python method not implemented. Will be implemented in a future update.',
              venvName: venvName || this.config.python.defaultVenvName
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Python execution error', { error: errorMessage, venvName });
      
      return {
        content: [
          {
            type: 'text',
            text: `Error executing Python code: ${errorMessage}`,
            mediaType: 'text/plain'
          }
        ],
        isError: true
      };
    }
  }

  private async handleInstallPackages(args: unknown): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    if (!isValidInstallArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Missing or invalid packages parameter. Please provide a comma-separated string or array of package names.'
      );
    }
    
    // Extract venvName from args
    const venvName = args.venvName;
    let packagesArray: string[] = [];
    
    // Convert packages to array if it's a string
    if (typeof args.packages === 'string') {
      packagesArray = args.packages.split(/,\s*/).filter(Boolean);
    } else if (Array.isArray(args.packages)) {
      packagesArray = args.packages.filter(pkg => typeof pkg === 'string' && pkg.trim() !== '');
    }
    
    if (packagesArray.length === 0) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'No valid packages specified for installation.'
      );
    }
    
    try {
      // Ensure the venv exists
      await this.venvManager.setupVirtualEnvironment(venvName);
      
      // Log which virtual environment is being used
      if (venvName) {
        this.logger.info('Installing packages in specified virtual environment', { venvName, packages: packagesArray });
      } else {
        this.logger.info('Installing packages in default virtual environment', { venvName: this.config.python.defaultVenvName, packages: packagesArray });
      }
      
      // Get activation details
      const { activateCmd, isWindows, pythonExecutable } = this.getActivationPrefix(venvName);
      
      // Check if we have the uv package installer (faster and more secure)
      let useUv = false;
      
      try {
        if (isWindows) {
          // On Windows, we need to use the activation command
          await execAsync(`${activateCmd}uv --version`);
        } else {
          // On Unix, we can directly check using spawn
          const { spawn } = require('child_process');
          
          // First try directly using UV from path
          const uvProcess = spawn(pythonExecutable, ['-m', 'uv', '--version']);
          
          await new Promise<void>((resolve, reject) => {
            uvProcess.on('close', (code: number) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error('UV not installed'));
              }
            });
            
            uvProcess.on('error', (err: Error) => {
              reject(err);
            });
          });
        }
        
        useUv = true;
        this.logger.info('Using UV package installer', { useUv });
      } catch (uvError) {
        this.logger.info('UV package installer not available, using pip', { 
          error: uvError instanceof Error ? uvError.message : String(uvError) 
        });
      }
      
      // Install packages using UV or pip
      let stdout = '';
      let stderr = '';
      
      if (isWindows) {
        // On Windows, we need to use the shell with activation command
        // This is less secure but necessary for activation to work properly
        const packageList = packagesArray.map(pkg => `"${pkg.replace(/"/g, '\\"')}"`).join(' ');
        const command = useUv
          ? `${activateCmd}uv pip install ${packageList}`
          : `${activateCmd}pip install ${packageList}`;
          
        const execOptions = {
          timeout: this.config.execution.packageTimeoutMs,
          env: { ...process.env },
          shell: 'cmd.exe'
        };
        
        const result = await execAsync(command, execOptions);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        // On Unix, we can directly use the Python executable path with spawn
        const { spawn } = require('child_process');
        
        const baseCommand = useUv ? ['-m', 'uv', 'pip'] : ['-m', 'pip'];
        const commandArgs = [...baseCommand, 'install', ...packagesArray];
        
        const installProcess = spawn(pythonExecutable, commandArgs, {
          timeout: this.config.execution.packageTimeoutMs,
          env: { ...process.env }
        });
        
        // Collect stdout and stderr
        installProcess.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        
        installProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        
        // Wait for completion
        await new Promise<void>((resolve, reject) => {
          installProcess.on('close', (code: number) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Package installation failed with code ${code}: ${stderr}`));
            }
          });
          
          installProcess.on('error', (err: Error) => {
            reject(err);
          });
        });
      }
      
      // Get installed packages to verify
      const installedPackages = await this.getInstalledPackages(venvName);
      const installedNames = Object.keys(installedPackages);
      
      // Check which packages were successfully installed
      const successfulInstalls = packagesArray.filter(pkg => {
        const pkgName = pkg.split('==')[0].split('>')[0].split('<')[0].split('~=')[0].trim();
        return installedNames.some(name => name.toLowerCase() === pkgName.toLowerCase());
      });
      
      const failedInstalls = packagesArray.filter(pkg => {
        const pkgName = pkg.split('==')[0].split('>')[0].split('<')[0].split('~=')[0].trim();
        return !installedNames.some(name => name.toLowerCase() === pkgName.toLowerCase());
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: failedInstalls.length > 0 ? 'partial' : 'success',
              message: `${successfulInstalls.length} package(s) installed successfully${failedInstalls.length > 0 ? `, ${failedInstalls.length} failed` : ''}`,
              venvName: venvName || this.config.python.defaultVenvName,
              installedPackages: successfulInstalls,
              failedPackages: failedInstalls,
              stdout: stdout.substring(0, 1000), // Limit output size
              stderr: stderr.substring(0, 1000) // Limit output size
            }, null, 2),
            mediaType: 'application/json'
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Package installation error', { error: errorMessage, venvName });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: `Error installing packages: ${errorMessage}`,
              venvName: venvName || this.config.python.defaultVenvName
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    }
  }

  private async handleHealthCheck(args?: any): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    try {
      // Extract venvName from args if provided
      const venvName = args?.venvName;
      
      // Basic health information
      const healthInfo: any = {
        status: 'ok',
        server: 'mcp-python-executor',
        venvManager: 'initialized',
        activeExecutions: this.activeExecutions
      };
      
      // Add venv-specific information if a venvName is provided
      if (venvName) {
        const venvExists = await this.checkVenvExists(venvName);
        if (venvExists) {
          healthInfo.venv = {
            name: venvName,
            exists: true,
            path: this.getVenvPath(venvName)
          };
          
          // Try to get the packages in this venv
          try {
            const packages = await this.getInstalledPackages(venvName);
            healthInfo.venv.packageCount = Object.keys(packages).length;
          } catch (pkgError) {
            healthInfo.venv.packageCount = 'error';
          }
        } else {
          healthInfo.venv = {
            name: venvName,
            exists: false
          };
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(healthInfo, null, 2),
            mediaType: 'application/json'
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: errorMessage
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    }
  }

  private async terminateExistingVenvProcesses(): Promise<void> {
    try {
      const isWindows = os.platform() === 'win32';
      const venvPath = this.getVenvPath();
      
      // Find Python processes from this venv using safer command execution
      let pids: string[] = [];
      
      if (isWindows) {
        // Windows: use wmic to find Python processes
        // Using spawn with array of arguments is safer, but wmic has a complex format
        // We'll still use exec for now, but with more careful path handling
        const sanitizedPath = venvPath.replace(/[\\'"]/g, ''); // Remove quotes and backslashes
        const command = `wmic process where "commandline like '%${sanitizedPath}%'" get processid /format:value`;
        
        const { stdout } = await execAsync(command);
        
        // Parse Windows wmic output format
        pids = stdout.split('\n')
          .map(line => line.trim())
          .filter(line => line.startsWith('ProcessId='))
          .map(line => line.replace('ProcessId=', ''));
      } else {
        // Unix: use ps and grep with array-based arguments for better security
        // Using spawn directly with careful arguments
        const { spawn } = require('child_process');
        
        // First, run ps to get all processes
        const ps = spawn('ps', ['aux']);
        let psOutput = '';
        
        ps.stdout.on('data', (data: Buffer) => {
          psOutput += data.toString();
        });
        
        await new Promise<void>((resolve) => {
          ps.on('close', () => resolve());
        });
        
        // Filter the output for our venv path
        pids = psOutput.split('\n')
          .filter(line => line.includes(venvPath) && !line.includes('grep'))
          .map(line => {
            const parts = line.trim().split(/\s+/);
            return parts.length > 1 ? parts[1] : '';
          })
          .filter(Boolean);
      }

      this.logger.info('Found existing venv processes', { count: pids.length });

      // Kill each process
      for (const pid of pids) {
        try {
          this.logger.info('Terminating process', { pid });
          process.kill(Number(pid));
        } catch (killError) {
          this.logger.warn('Failed to terminate process', {
            pid,
            error: killError instanceof Error ? killError.message : String(killError)
          });
        }
      }

      this.logger.info('Terminated existing venv processes', {
        processCount: pids.length
      });
    } catch (error) {
      this.logger.error('Error terminating existing venv processes', {
        error: error instanceof Error ? error.message : String(error)
      });
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
    try {
      // Use spawn with array arguments for better security
      const { spawn } = require('child_process');
      const python = spawn('python', ['--version']);
      
      let stdout = '';
      
      python.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      
      // Python might output version to stderr on older versions
      python.stderr.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      
      await new Promise<void>((resolve, reject) => {
        python.on('close', (code: number) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Python process exited with code ${code}`));
          }
        });
        
        python.on('error', (err: Error) => {
          reject(err);
        });
      });
      
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to verify Python version', { error: errorMessage });
      throw new Error(`Failed to verify Python version: ${errorMessage}`);
    }
  }

  /**
   * Get the path to the virtual environment
   * 
   * @param venvName Optional name of the virtual environment
   * @returns Absolute path to the virtual environment directory
   * @throws ExecutorError if the path is invalid
   */
  private getVenvPath(venvName?: string): string {
    // Use the venvManager to get the path for the specified venv or default venv
    if (!this.venvManager) {
      throw new ExecutorError(ErrorCode.INTERNAL_ERROR, `VenvManager not initialized.`);
    }
    
    return this.venvManager.getVenvPath(venvName);
  }

  /**
   * Get activation command and python executable path for the virtual environment
   * 
   * @param venvName Optional name of the virtual environment
   * @returns Object containing activation command, Windows flag, and python executable path
   */
  private getActivationPrefix(venvName?: string): { activateCmd: string, isWindows: boolean, pythonExecutable: string } {
    if (!this.venvManager) {
      throw new ExecutorError(ErrorCode.INTERNAL_ERROR, `VenvManager not initialized.`);
    }
    
    // Use the venvManager to get activation details for the specified venv
    const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(venvName);
    return { activateCmd, isWindows, pythonExecutable };
  }

  /**
   * Check if the virtual environment exists
   * 
   * @param venvName Optional name of the virtual environment
   * @returns Promise that resolves to true if the venv exists, false otherwise
   */
  private async checkVenvExists(venvName?: string): Promise<boolean> {
    if (!this.venvManager) {
      throw new ExecutorError(ErrorCode.INTERNAL_ERROR, `VenvManager not initialized.`);
    }
    
    return this.venvManager.checkVenvExists(venvName);
  }

  /**
   * Test the virtual environment to verify it's working properly
   * 
   * @returns Promise that resolves when the test is complete
   */
  private async testVirtualEnvironment(): Promise<void> {
    try {
      // Wait for venvManager to be initialized properly in run()
      if (!this.venvManager) {
        this.logger?.debug?.('VenvManager not initialized yet, skipping test');
        return;
      }

      const details = this.venvManager.getActivationDetails();
      const { activateCmd, isWindows, pythonExecutable, venvPath } = details;
      
      // Create a temporary script to test the virtual environment
      const tempScript = path.join(this.tempDir, `test_venv_${Date.now()}.py`);
      const testCode = `
import sys
print(f"Python path: {sys.executable}")
print(f"Python version: {sys.version}")
try:
    import numpy as np
    print("NumPy imported successfully")
except ImportError:
    print("NumPy import failed")
try:
    from scipy import stats
    print("SciPy imported successfully")
except ImportError:
    print("SciPy import failed")
try:
    import matplotlib.pyplot as plt
    print("Matplotlib imported successfully")
except ImportError:
    print("Matplotlib import failed")
`;
      
      // Write the test script
      await fs.writeFile(tempScript, testCode);
      
      // Execute the test script using the virtual environment
      // Use array-based execution for better security
      let stdout = '';
      let stderr = '';
      
      try {
        if (isWindows) {
          // On Windows, we need to use the shell with activation command
          // This is less secure but necessary for activation to work properly
          const command = `${activateCmd}python "${tempScript}"`;
          const execOptions = {
            timeout: this.config.execution.timeoutMs,
            env: { ...process.env },
            shell: 'cmd.exe'
          };
          
          const result = await execAsync(command, execOptions);
          stdout = result.stdout;
          stderr = result.stderr;
        } else {
          // On Unix, we can directly use the Python executable path
          const { spawn } = require('child_process');
          const python = spawn(pythonExecutable, [tempScript], {
            timeout: this.config.execution.timeoutMs,
            env: { ...process.env }
          });
          
          // Collect stdout and stderr
          python.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
          
          python.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
          
          // Wait for completion
          await new Promise<void>((resolve, reject) => {
            python.on('close', (code: number) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Python process exited with code ${code}`));
              }
            });
            
            python.on('error', (err: Error) => {
              reject(err);
            });
          });
        }
        
        process.stderr.write("VENV TEST RESULTS:\n");
        process.stderr.write(stdout + "\n");
        
        if (stderr) {
          process.stderr.write("VENV TEST STDERR:\n");
          process.stderr.write(stderr + "\n");
        }
      } finally {
        // Clean up the temporary script regardless of whether the execution succeeded
        await fs.unlink(tempScript).catch((err) => {
          this.logger.warn('Failed to delete temporary test script', {
            path: tempScript,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    } catch (error) {
      process.stderr.write(`VENV TEST ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * Initialize the server and start handling requests
   */
  async run() {
    try {
      // Load configuration
      this.config = await loadConfig();
      
      // Initialize venv manager
      this.venvManager = new VenvManager(this.config, this.logger);
      
      // Make sure the default venv exists
      await this.venvManager.setupVirtualEnvironment();
      
      // Create transport and connect server
      const transport = new StdioServerTransport();
      this.server.connect(transport);
      
      this.logger.info("Server started successfully");
    } catch (error) {
      console.error("CRITICAL STARTUP ERROR: ", error);
      process.exit(1);
    }
  }

  // Updated method stubs with proper return types
  private async handleListPackages(args: any): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    try {
      const venvName = args?.venvName;
      
      // Verify the environment exists
      const venvExists = await this.checkVenvExists(venvName);
      if (!venvExists) {
        const targetVenvName = venvName || this.config.python.defaultVenvName;
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          `Virtual environment does not exist: ${targetVenvName}`
        );
      }
      
      // Log which virtual environment is being used
      if (venvName) {
        this.logger.info('Listing packages from specified virtual environment', { venvName });
      } else {
        this.logger.info('Listing packages from default virtual environment', { venvName: this.config.python.defaultVenvName });
      }
      
      // Get the packages using the modified getInstalledPackages method
      const packages = await this.getInstalledPackages(venvName);
      
      // Return packages in a structured format
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              packages,
              venvName: venvName || this.config.python.defaultVenvName
            }, null, 2),
            mediaType: 'application/json'
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Error listing packages', {
        error: errorMessage,
        venvName: args?.venvName
      });

      return {
        content: [
          {
            type: 'text',
            text: `Error listing packages: ${errorMessage}`,
            mediaType: 'text/plain'
          }
        ],
        isError: true
      };
    }
  }
  
  private async handleUninstallPackages(args: unknown): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    try {
      if (!isValidInstallArgs(args)) {
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          'Missing or invalid packages parameter. Please provide a comma-separated string or array of package names.'
        );
      }
      
      // Extract venvName from args
      const venvName = args.venvName;
      
      // Verify the environment exists
      const venvExists = await this.checkVenvExists(venvName);
      if (!venvExists) {
        const targetVenvName = venvName || this.config.python.defaultVenvName;
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          `Virtual environment does not exist: ${targetVenvName}`
        );
      }
      
      // Convert packages to array if it's a string
      let packagesArray: string[] = [];
      if (typeof args.packages === 'string') {
        packagesArray = args.packages.split(/,\s*/).filter(Boolean);
      } else if (Array.isArray(args.packages)) {
        packagesArray = args.packages.filter(pkg => typeof pkg === 'string' && pkg.trim() !== '');
      }
      
      if (packagesArray.length === 0) {
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          'No valid packages specified for uninstallation.'
        );
      }
      
      // Log which virtual environment is being used
      if (venvName) {
        this.logger.info('Uninstalling packages from specified virtual environment', { venvName, packages: packagesArray });
      } else {
        this.logger.info('Uninstalling packages from default virtual environment', { venvName: this.config.python.defaultVenvName, packages: packagesArray });
      }
      
      // Get activation details
      const { activateCmd, isWindows, pythonExecutable } = this.getActivationPrefix(venvName);
      
      // Get current installed packages to verify uninstallation later
      const installedPackagesBefore = await this.getInstalledPackages(venvName);
      
      // Uninstall packages
      let stdout = '';
      let stderr = '';
      
      if (isWindows) {
        // On Windows, we need to use the shell with activation command
        const packageList = packagesArray.map(pkg => `"${pkg.replace(/"/g, '\\"')}"`).join(' ');
        const command = `${activateCmd}pip uninstall -y ${packageList}`;
        
        const execOptions = {
          timeout: this.config.execution.packageTimeoutMs,
          env: { ...process.env },
          shell: 'cmd.exe'
        };
        
        const result = await execAsync(command, execOptions);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        // On Unix, we can use spawn directly with the Python executable
        const { spawn } = require('child_process');
        
        const uninstallProcess = spawn(
          pythonExecutable, 
          ['-m', 'pip', 'uninstall', '-y', ...packagesArray],
          {
            timeout: this.config.execution.packageTimeoutMs,
            env: { ...process.env }
          }
        );
        
        // Collect stdout and stderr
        uninstallProcess.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        
        uninstallProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        
        // Wait for completion
        await new Promise<void>((resolve, reject) => {
          uninstallProcess.on('close', (code: number) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Package uninstallation failed with code ${code}: ${stderr}`));
            }
          });
          
          uninstallProcess.on('error', (err: Error) => {
            reject(err);
          });
        });
      }
      
      // Get installed packages after uninstallation to verify
      const installedPackagesAfter = await this.getInstalledPackages(venvName);
      
      // Check which packages were successfully uninstalled
      const successfulUninstalls: string[] = [];
      const failedUninstalls: string[] = [];
      
      packagesArray.forEach(pkg => {
        const pkgName = pkg.split('==')[0].split('>')[0].split('<')[0].split('~=')[0].trim().toLowerCase();
        
        const wasInstalled = Object.keys(installedPackagesBefore)
          .some(name => name.toLowerCase() === pkgName);
        
        const isStillInstalled = Object.keys(installedPackagesAfter)
          .some(name => name.toLowerCase() === pkgName);
        
        // If it was installed and is no longer installed, it was successfully uninstalled
        if (wasInstalled && !isStillInstalled) {
          successfulUninstalls.push(pkg);
        } 
        // If it was installed and is still installed, uninstallation failed
        else if (wasInstalled && isStillInstalled) {
          failedUninstalls.push(pkg);
        }
        // If it wasn't installed, we can't uninstall it (but we don't count this as a failure)
        else if (!wasInstalled) {
          this.logger.info(`Package was not installed, skipping: ${pkg}`);
        }
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: failedUninstalls.length > 0 ? 'partial' : 'success',
              message: `${successfulUninstalls.length} package(s) uninstalled successfully${failedUninstalls.length > 0 ? `, ${failedUninstalls.length} failed` : ''}`,
              venvName: venvName || this.config.python.defaultVenvName,
              uninstalledPackages: successfulUninstalls,
              failedPackages: failedUninstalls,
              stdout: stdout.substring(0, 1000), // Limit output size
              stderr: stderr.substring(0, 1000) // Limit output size
            }, null, 2),
            mediaType: 'application/json'
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Package uninstallation error', {
        error: errorMessage,
        venvName: (args as any)?.venvName
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: `Error uninstalling packages: ${errorMessage}`,
              venvName: (args as any)?.venvName || this.config.python.defaultVenvName
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    }
  }

  private async handleAnalyzeCode(args: any): Promise<{ content: { type: string; text: string; mediaType: string; }[]; isError?: boolean; }> {
    if (!args || typeof args !== 'object' || typeof args.code !== 'string') {
      throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid code parameter. Please provide valid code for analysis.');
    }
    
    // Extract venvName from args
    const venvName = args.venvName;
    
    try {
      // Verify the environment exists
      const venvExists = await this.checkVenvExists(venvName);
      if (!venvExists) {
        const targetVenvName = venvName || this.config.python.defaultVenvName;
        throw new ExecutorError(
          ErrorCode.INTERNAL_ERROR, 
          `Virtual environment does not exist: ${targetVenvName}`
        );
      }
      
      // Use the venvManager to perform the operation with the specified venv
      if (venvName) {
        this.logger.info('Using specified virtual environment for code analysis', { venvName });
      }
      
      // Return not implemented until we complete the real logic
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'not_implemented',
              message: 'Analyze code method not implemented. Will be implemented in a future update.',
              venvName: venvName || this.config.python.defaultVenvName
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Code analysis error', { error: errorMessage, venvName });
      
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing code: ${errorMessage}`,
            mediaType: 'text/plain'
          }
        ],
        isError: true
      };
    }
  }
}

// At the end of src/index.ts, replace the server.run() call with:
try {
  // Use console.error here as logger might not be initialized yet
  console.error("STARTUP: Creating PythonExecutorServer instance");
  const server = new PythonExecutorServer();

  // Now logger should be initialized, prefer using it
  server.logger.info("STARTUP: PythonExecutorServer instance created");

  server.logger.info("STARTUP: Calling server.run()");
  server.run().catch((error) => {
    // Logger should be available here
    server.logger.error(`FATAL RUNTIME ERROR: ${error instanceof Error ? error.message : String(error)}`, { 
      stack: error instanceof Error ? error.stack : 'No stack available'
    });
    process.exit(1); // Exit after logging runtime error
  });
  server.logger.info("STARTUP: After server.run() call (server likely running)");

} catch (initError) {
  // Logger is likely *not* initialized here, use console.error
  console.error(`CRITICAL INITIALIZATION ERROR: ${initError instanceof Error ? initError.message : String(initError)}`);
  console.error(initError instanceof Error && initError.stack ? initError.stack : 'No stack trace available');
  process.exit(1); // Exit after logging init error
}
