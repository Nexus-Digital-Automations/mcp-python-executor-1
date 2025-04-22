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

// Add direct console logging at the very beginning
console.log("STARTUP: Beginning process initialization");
process.on('uncaughtException', (err) => {
  console.log(`CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
  console.log(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.log('CRITICAL UNHANDLED REJECTION:', reason);
  process.exit(1);
});

const execAsync = promisify(exec);

interface ExecutePythonArgs {
  code?: string;
  scriptPath?: string;
  inputData?: string[];
}

interface InstallPackageArgs {
  packages: string | string[];
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
        args.inputData.every((item: any) => typeof item === 'string')))
  );
};

const isValidInstallArgs = (args: any): args is InstallPackageArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.packages === 'string' ||
      (Array.isArray(args.packages) &&
        args.packages.every((pkg: any) => typeof pkg === 'string')))
  );
};

class PythonExecutorServer {
  private server: Server;
  private tempDir: string;
  private config = loadConfig();
  private logger: Logger;
  private activeExecutions = 0;
  private cleanupInterval: NodeJS.Timeout;
  private venvLockPromise: Promise<void> | null = null;

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
    console.log("STARTUP: Beginning server construction");
    
    try {
      this.server = new Server({
        name: 'mcp-python-executor',
        version: '0.2.0',
        capabilities: {
          prompts: {},
          tools: {}
        }
      });
      console.log("STARTUP: Created server instance");

      this.cleanupInterval = setInterval(
        () => this.cleanupTempFiles(),
        this.config.temp.cleanupIntervalMs
      );
      console.log("STARTUP: Set up cleanup interval");

      this.logger = new Logger(this.config.logging);
      console.log("STARTUP: Created logger");

      // Create temp directory for script files
      this.tempDir = path.join(os.tmpdir(), 'python-executor');
      console.log(`STARTUP: Setting temp directory to ${this.tempDir}`);
      fs.mkdir(this.tempDir, { recursive: true }).catch(
        (err) => console.log(`STARTUP ERROR: Failed to create temp directory: ${err.message}`)
      );

      // Enable code analysis features - COMMENT THESE OUT FOR TESTING
      // this.config.python.analysis.enableSecurity = true;
      // this.config.python.analysis.enableStyle = true;
      // this.config.python.analysis.enableComplexity = true;

      console.log("STARTUP: Setting up handlers");
      this.setupPromptHandlers();
      this.setupToolHandlers();
      
      // TEMPORARILY DISABLE THIS FOR TESTING
      // this.initializePreinstalledPackages();
      console.log("STARTUP: Skipping preinstalled packages initialization");

      // Error handling
      this.server.onerror = (error) => {
        console.log(`SERVER ERROR: ${error}`);
        this.logger.error('MCP Error', { error });
      };
      process.on('SIGINT', async () => {
        await this.server.close();
        process.exit(0);
      });
      
      console.log("STARTUP: Server construction completed successfully");
    } catch (error) {
      console.log(`CRITICAL STARTUP ERROR: ${error instanceof Error ? error.message : String(error)}`);
      console.log(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
      throw error;
    }
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
  "inputData": ["optional", "input", "strings"]
}

Example usage with a script file:
{
  "scriptPath": "/path/to/your/script.py",
  "inputData": ["optional", "input", "strings"]
}

Common workflows:
1. Data processing:
   - FIRST check/install numpy and pandas
   - THEN load and process data
   - Output results

2. Machine learning:
   - FIRST check/install scikit-learn
   - THEN train model
   - Make predictions

3. Web scraping:
   - FIRST check/install requests and beautifulsoup4
   - THEN fetch and parse content
   - Extract data`,
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
  "packages": "numpy>=1.20.0, pandas, matplotlib"
}

or with array format:
{
  "packages": ["numpy>=1.20.0", "pandas", "matplotlib"]
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
            properties: {},
            required: [],
          },
        },
        {
          name: 'analyze_code',
          description: `Analyze Python code for security, style, and complexity issues.

Features:
- Security vulnerability detection
- PEP 8 style checking
- Cyclomatic complexity analysis
- Import validation
- Resource usage estimation

Example workflow:
1. Write or paste your Python code
2. Enable desired analysis types
3. Call analyze_code
4. Review and fix issues
5. Repeat until clean

Example usage:
{
  "code": "def process_data(data):\\n    try:\\n        return data.process()\\n    except:\\n        pass",
  "enableSecurity": true,
  "enableStyle": true,
  "enableComplexity": true
}

Common workflows:
1. Security audit:
   - Enable security scanning
   - Check for vulnerabilities
   - Fix security issues

2. Code review:
   - Run full analysis
   - Review all issues
   - Make improvements

3. Continuous improvement:
   - Regular style checks
   - Complexity monitoring
   - Security scanning`,
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to analyze',
              },
              enableSecurity: {
                type: 'boolean',
                description: 'Enable security vulnerability scanning',
              },
              enableStyle: {
                type: 'boolean',
                description: 'Enable PEP 8 style checking',
              },
              enableComplexity: {
                type: 'boolean',
                description: 'Enable complexity analysis',
              }
            },
            required: ['code'],
          },
        },
        {
          name: 'list_packages',
          description: `List all installed packages in the virtual environment.

Features:
- Lists all installed Python packages with their versions
- Shows package dependencies
- Provides detailed package information

Example workflow:
1. Use list_packages to verify installations
2. Check package versions and dependencies

Example usage:
{}  // No parameters required

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
            properties: {},
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
  "packages": "numpy,pandas,matplotlib"
}

or with array format:
{
  "packages": ["numpy", "pandas", "matplotlib"]
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
              }
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
        case 'health_check':
          return this.handleHealthCheck();
        case 'analyze_code':
          return this.handleAnalyzeCode(request.params.arguments);
        case 'uninstall_packages':
          return this.handleUninstallPackages(request.params.arguments);
        case 'list_packages':
          return this.handleListPackages(request.params.arguments);
        default:
          throw new McpError(
            McpErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async getInstalledPackages(): Promise<Record<string, string>> {
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
      const venvExists = await this.checkVenvExists();
      if (!venvExists) {
        this.logger.warn('Attempted to get packages from non-existent venv', { path: this.config.python.venvPath });
        throw new ExecutorError(ErrorCode.INVALID_INPUT, `Virtual environment does not exist.`);
      }

      // Get activation prefix for the virtual environment
      const { activateCmd, isWindows } = this.getActivationPrefix();
      const command = `${activateCmd}python "${scriptPath}"`;
      
      this.logger.info('Getting installed packages', { command });

      // For Windows, we need to use cmd.exe to properly handle the activation
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

  private async handleListVenvs() {
    let venvNames: string[] = [];
    const basePath = (this.config.python as any).venvsBasePath;
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const cfgPath = path.join(basePath, entry.name, 'pyvenv.cfg');
          try {
            await fs.access(cfgPath);
            venvNames.push(entry.name);
          } catch { /* Ignore non-venv dirs */ }
        }
      }
      this.logger.info('Listed venvs', { count: venvNames.length });
      return { content: [{ type: 'text', text: JSON.stringify({ venvs: venvNames }, null, 2), mediaType: 'application/json' }] };
    } catch (error: any) {
      let status = 'error';
      let message = `Failed to list venvs: ${error.message}`;
      let responseObj: any = { venvs: [] };

      if (error.code === 'ENOENT') {
        status = 'success'; // Base dir doesn't exist, so 0 venvs.
        message = 'Venvs base directory does not exist.';
        this.logger.info(message, { path: basePath });
        responseObj.message = message;
      } else if (error.code === 'EACCES') {
        status = 'error';
        message = 'Permission denied accessing venvs base directory.';
        this.logger.error(message, { path: basePath });
        responseObj.error = message;
      } else {
        this.logger.error('Failed to list virtual environments', { error });
        responseObj.error = message;
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(responseObj, null, 2),
          mediaType: 'application/json'
        }],
        isError: status === 'error'
      };
    }
  }

  /**
   * Tool handler for create_venv command - creates a new virtual environment
   * 
   * @param args - Arguments containing venvName
   * @returns Success/error response with details
   */
  private async handleCreateVenv(args: any) {
    // Validate input arguments
    const venvName = args?.venvName;
    if (!venvName || typeof venvName !== 'string') {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT, 
        'Missing or invalid venvName argument. Please provide a name for the virtual environment.'
      );
    }

    try {
      // Validate the venv name (this will throw if invalid)
      const venvPath = this.getVenvPath(venvName);

      // Check if the venv already exists
      const venvExists = await this.checkVenvExists(venvName);
      if (venvExists) {
        this.logger.info('Virtual environment already exists', { venvName, path: venvPath });
        return { 
          content: [{ 
            type: 'text', 
            text: JSON.stringify(
              { status: 'exists', message: `Virtual environment '${venvName}' already exists`, venvName, path: venvPath }, 
              null, 2
            ), 
            mediaType: 'application/json' 
          }] 
        };
      }

      // Create the virtual environment (setupVirtualEnvironment handles locking)
      await this.setupVirtualEnvironment(venvName);
      
      // Return success response
      return { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify(
            { status: 'created', message: `Successfully created virtual environment '${venvName}'`, venvName, path: venvPath }, 
            null, 2
          ), 
          mediaType: 'application/json' 
        }] 
      };
    } catch (error: any) {
      // Log the error
      this.logger.error('Failed to create virtual environment', { 
        venvName, 
        error: error.message || String(error) 
      });
      
      // Format a user-friendly error message
      let errorMessage = `Failed to create virtual environment '${venvName}'`;
      if (error instanceof ExecutorError) {
        errorMessage += `: ${error.message}`;
      } else {
        errorMessage += `: ${error.message || 'Unknown error'}`;
      }
      
      // Return error response
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: 'error', message: errorMessage, venvName }, 
            null, 2
          ),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  /**
   * Tool handler for delete_venv command - safely deletes an existing virtual environment
   * 
   * @param args - Arguments containing venvName
   * @returns Success/error response with details
   */
  private async handleDeleteVenv(args: any) {
    // Validate input arguments
    const venvName = args?.venvName;
    if (!venvName || typeof venvName !== 'string') {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT, 
        'Missing or invalid venvName argument. Please provide the name of the virtual environment to delete.'
      );
    }
    
    // Don't allow deletion of the default environment unless explicitly confirmed
    const isDefault = venvName === (this.config.python as any).defaultVenvName;
    const confirmed = args?.confirm === true;
    
    if (isDefault && !confirmed) {
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
    
    try {
      // Validate the venv name format (getVenvPath will throw if invalid)
      const venvPath = this.getVenvPath(venvName);

      // Use withVenvLock to prevent deletion during other operations
      return this.withVenvLock(async () => {
        // Check if the environment exists
        const venvExists = await this.checkVenvExists(venvName);
        if (!venvExists) {
          this.logger.info('Attempted to delete non-existent virtual environment', { venvName });
          return { 
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                status: 'not_found', 
                message: `Virtual environment '${venvName}' does not exist or was already deleted`, 
                venvName
              }, null, 2), 
              mediaType: 'application/json' 
            }] 
          };
        }

        try {
          // Log the action
          this.logger.info('Deleting virtual environment', { venvName, path: venvPath });
          
          // Actually delete the directory
          await fs.rm(venvPath, { recursive: true, force: true });
          
          // Log success
          this.logger.info('Successfully deleted virtual environment', { venvName, path: venvPath });
          
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
          // Log the deletion error
          this.logger.error('Failed to delete virtual environment', { 
            venvName, 
            path: venvPath, 
            error: error.message || String(error) 
          });
          
          // Return an error response
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
      });
    } catch (error: any) {
      // Handle errors from getVenvPath validation
      this.logger.error('Failed to validate venv for deletion', { venvName, error: error.message });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error', 
            message: `Invalid virtual environment name '${venvName}': ${error.message}`,
            venvName
          }, null, 2),
          mediaType: 'application/json'
        }],
        isError: true
      };
    }
  }

  private async handleUninstallPackages(args: unknown) {
    // Validate input
    if (!isValidInstallArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Invalid package uninstallation arguments'
      );
    }

    try {
      // Check if the virtual environment exists
      const venvExists = await this.checkVenvExists();
      if (!venvExists) {
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          `Virtual environment not found.`
        );
      }

      // Get list of currently installed packages before uninstallation
      const installedPackagesBefore = await this.getInstalledPackages();

      // Convert input to array of packages
      const packagesArray = typeof args.packages === 'string'
        ? args.packages.split(',').map(p => p.trim()).filter(p => p)
        : args.packages;

      // Log the packages to be uninstalled
      this.logger.info('Preparing to uninstall packages', {
        packagesCount: packagesArray.length,
        packages: packagesArray,
      });

      // Get activation details for the venv
      const { activateCmd, isWindows } = this.getActivationPrefix();

      // Prepare packages string with proper quoting
      const packagesString = packagesArray.map(pkg => `"${pkg.replace(/"/g, '\\"')}"`).join(' ');

      // Construct uninstall command with -y for automatic yes
      const command = `${activateCmd}uv pip uninstall -y ${packagesString}`;
      this.logger.info('Uninstalling packages with command', { command });

      // Execute the uninstall command
      const execOptions = {
        timeout: this.config.execution.packageTimeoutMs,
        env: { ...process.env },
        ...(isWindows ? { shell: 'cmd.exe' } : {})
      };

      let stdout = '';
      let stderr = '';

      try {
        const result = await execAsync(command, execOptions);
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Package uninstallation error', { 
          error: errorMessage 
        });
        throw error;
      }

      // Get list of installed packages after uninstallation
      const installedPackagesAfter = await this.getInstalledPackages();

      // Verify uninstallation by comparing before and after states
      const uninstallationResults = packagesArray.map(pkg => {
        const pkgName = pkg.toLowerCase();
        const wasInstalled = pkgName in installedPackagesBefore;
        const isStillInstalled = pkgName in installedPackagesAfter;
        return {
          package: pkg,
          wasInstalled,
          wasUninstalled: wasInstalled && !isStillInstalled,
          status: !wasInstalled ? 'not_found' : 
                 isStillInstalled ? 'failed' : 'success'
        };
      });

      // Calculate success metrics
      const successfulUninstalls = uninstallationResults.filter(r => r.status === 'success');
      const failedUninstalls = uninstallationResults.filter(r => r.status === 'failed');
      const notFoundPackages = uninstallationResults.filter(r => r.status === 'not_found');

      // Log results
      this.logger.info('Package uninstallation completed', {
        successful: successfulUninstalls.length,
        failed: failedUninstalls.length,
        notFound: notFoundPackages.length
      });

      return {
        content: [
          {
            type: 'text',
            text: stdout + (stderr ? `\nWarnings/Errors:\n${stderr}` : ''),
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: failedUninstalls.length === 0 ? 'success' : 'partial',
              results: uninstallationResults,
              summary: {
                total: packagesArray.length,
                successful: successfulUninstalls.length,
                failed: failedUninstalls.length,
                notFound: notFoundPackages.length
              },
              details: {
                successfulUninstalls: successfulUninstalls.map(r => r.package),
                failedUninstalls: failedUninstalls.map(r => r.package),
                notFoundPackages: notFoundPackages.map(r => r.package)
              }
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: failedUninstalls.length > 0
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Package uninstallation error', { 
        error: errorMessage 
      });

      return {
        content: [
          {
            type: 'text',
            text: `Error uninstalling packages: ${errorMessage}`,
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
              errorMessage: errorMessage,
              packagesRequested: args.packages
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler for the list_packages tool - lists all installed packages in the virtual environment
   * 
   * @param args - Arguments (ignored)
   * @returns List of installed packages with versions
   */
  private async handleListPackages(args: any) {
    try {
      // Check if the virtual environment exists
      const venvExists = await this.checkVenvExists();
      if (!venvExists) {
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          `Virtual environment does not exist.`
        );
      }

      // Get the list of installed packages
      const installedPackages = await this.getInstalledPackages();

      // Sort packages by name for consistent output
      const sortedPackages = Object.entries(installedPackages)
        .sort(([a], [b]) => a.localeCompare(b))
        .reduce((obj, [key, value]) => ({
          ...obj,
          [key]: value
        }), {});

      // Create a formatted text representation
      const textOutput = Object.entries(sortedPackages)
        .map(([name, version]) => `${name}==${version}`)
        .join('\n');

      // Return both text and JSON formats
      return {
        content: [
          {
            type: 'text',
            text: textOutput,
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              packageCount: Object.keys(sortedPackages).length,
              packages: sortedPackages
            }, null, 2),
            mediaType: 'application/json'
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Error listing packages', {
        error: errorMessage
      });

      return {
        content: [
          {
            type: 'text',
            text: `Error listing packages: ${errorMessage}`,
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
              errorMessage: errorMessage
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Tool handler for health_check - provides server health and configuration status
   * 
   * @returns Health check information including metrics and virtual environment
   */
  private async handleHealthCheck() {
    try {
      // Get Python version
      const pythonVersion = await this.getPythonVersion();
      
      // Get metrics statistics
      const stats = metrics.getStats();
      
      // Get packages installed in the environment
      const installedPackages = await this.getInstalledPackages();
      
      // Check if environment exists
      const venvExists = await this.checkVenvExists();
      const venvPath = this.getVenvPath();
      
      // Return comprehensive health information
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
              packageManager: {
                type: 'uv',
                status: 'active'
              },
              virtualEnvironment: {
                exists: venvExists,
                path: venvPath
              },
              installedPackages,
            }, null, 2),
            mediaType: 'application/json'
          },
        ],
      };
    } catch (error) {
      // Handle errors gracefully with partial information
      this.logger.error('Error during health check', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'degraded',
              version: '0.2.0',
              error: error instanceof Error ? error.message : String(error),
              config: this.config,
              activeExecutions: this.activeExecutions,
            }, null, 2),
            mediaType: 'application/json'
          },
        ],
      };
    }
  }

  private async terminateExistingVenvProcesses(): Promise<void> {
    try {
      const isWindows = os.platform() === 'win32';
      const venvPath = this.getVenvPath();
      
      // Construct the command to find Python processes from this venv
      let command: string;
      if (isWindows) {
        // Windows: use wmic to find and kill Python processes
        command = `wmic process where "commandline like '%${venvPath}%'" get processid /format:value`;
      } else {
        // Unix: use ps and grep to find Python processes
        command = `ps aux | grep "${venvPath}" | grep -v grep`;
      }

      this.logger.info('Looking for existing venv processes', { command });

      const { stdout } = await execAsync(command);
      
      if (stdout.trim()) {
        // Extract process IDs
        let pids: string[] = [];
        if (isWindows) {
          // Parse Windows wmic output format
          pids = stdout.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('ProcessId='))
            .map(line => line.replace('ProcessId=', ''));
        } else {
          // Parse Unix ps output format
          pids = stdout.split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.split(/\s+/)[1]);
        }

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
      } else {
        this.logger.info('No existing venv processes found');
      }
    } catch (error) {
      this.logger.error('Error terminating existing venv processes', {
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't throw - we want to continue with execution even if termination fails
    }
  }

  private async handleExecutePython(args: unknown) {
    // Check basic argument structure
    if (!isValidExecuteArgs(args)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Invalid Python execution arguments'
      );
    }

    // Log a strong warning about checking dependencies first (without blocking execution)
    this.logger.warn('⚠️ REMINDER: Always verify dependencies BEFORE execute_python!', {
      recommendation: 'Use list_packages and install_packages first to prevent "module not found" errors'
    });

    // Check for common imports in the code and verify if they're installed
    let missingDependencies: string[] = [];
    if (args && typeof (args as any).code === 'string') {
      const code = (args as any).code;
      // Extract import statements using regex
      const importRegex = /^\s*(?:from\s+(\S+)|import\s+([^\s,]+))/gm;
      const imports = new Set<string>();
      
      let match;
      while ((match = importRegex.exec(code)) !== null) {
        const moduleName = match[1] || match[2];
        // Handle potential 'as' keyword in imports
        const cleanedModuleName = moduleName.split(' as ')[0];
        // Get the top-level package name (before the first dot)
        const packageName = cleanedModuleName.split('.')[0];
        if (packageName && !['os', 'sys', 'time', 're', 'json', 'math', 'random', 'datetime'].includes(packageName)) {
          imports.add(packageName);
        }
      }
      
      if (imports.size > 0) {
        // Get installed packages
        try {
          const installedPackages = await this.getInstalledPackages();
          const installedNames = Object.keys(installedPackages).map(p => p.toLowerCase());
          
          // Find imports that might not be installed
          missingDependencies = Array.from(imports).filter(
            imp => !installedNames.some(pkg => pkg === imp.toLowerCase())
          );
          
          if (missingDependencies.length > 0) {
            this.logger.warn('⚠️ POTENTIAL MISSING DEPENDENCIES DETECTED!', {
              imports: missingDependencies,
              message: `Code appears to import packages that might not be installed: ${missingDependencies.join(', ')}`
            });
            
            // Log a warning but don't block execution
            this.logger.warn('⚠️ Continuing execution despite potential missing dependencies', {
              recommendation: `If execution fails, run install_packages with {"packages": "${missingDependencies.join(', ')}"} first`
            });
            
            // Continue execution without blocking - the Python error will show the real issue if modules are missing
          }
        } catch (error) {
          // Log but continue - we'll let execution fail naturally if there's an issue
          this.logger.error('Error checking for installed packages', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // If we got here, either no dependencies were detected or they're all installed

    // Log the current execution state
    this.logger.info('Python execution request received', { 
      activeExecutions: this.activeExecutions,
      maxConcurrent: this.config.execution.maxConcurrent
    });

    // Terminate any existing venv processes before proceeding
    await this.terminateExistingVenvProcesses();

    // If we're at the execution limit, terminate existing executions to make room
    if (this.activeExecutions >= this.config.execution.maxConcurrent) {
      this.logger.warn('Maximum concurrent executions reached. Terminating existing executions to make room.', {
        currentCount: this.activeExecutions,
        maxAllowed: this.config.execution.maxConcurrent
      });
      
      // Reset the active executions counter to allow this new execution
      this.activeExecutions = 0;
    }

    const startTime = Date.now();
    this.activeExecutions++;

    // Wrap execution in lock
    return this.withVenvLock(async () => {
      try {
        // Ensure the virtual environment exists
        await this.setupVirtualEnvironment();

        // Determine the script path - either from args.scriptPath or by creating a temp file for code
        let scriptPath: string;
        let isTemporaryScript = false;

      if ((args as any).scriptPath) {
        // Use provided script path
        scriptPath = (args as any).scriptPath;

        // Verify the script exists
        try {
          await fs.access(scriptPath);
        } catch (error) {
          throw new ExecutorError(
            ErrorCode.INVALID_INPUT,
            `Script file not found: ${scriptPath}`
          );
        }
      } else if ((args as any).code) {
        // Create temporary script file from code string
        scriptPath = path.join(
          this.tempDir,
          `script_${Date.now()}.py`
        );
        await fs.writeFile(scriptPath, (args as any).code);
        isTemporaryScript = true;
      } else {
        // This should never happen due to isValidExecuteArgs check
        throw new ExecutorError(
          ErrorCode.INVALID_INPUT,
          'Either code or scriptPath must be provided'
        );
      }

        // Determine activation and python executable
        const { activateCmd, isWindows, pythonExecutable } = this.getActivationPrefix();
        
        let results: string[];

        if ((args as any).inputData && (args as any).inputData.length > 0) {
          this.logger.info('Input data provided, will use python-shell', {
            inputDataLength: (args as any).inputData.length
          });

          // When input data is provided, use PythonShell for stdin
          const options: Options = {
            mode: 'text',
            pythonPath: pythonExecutable,
            pythonOptions: ['-u'],
            scriptPath: path.dirname(scriptPath),
            args: (args as any).inputData || [],
          };

          // Execute with timeout
          results = await Promise.race([
            new Promise<string[]>((resolve, reject) => {
              let pyshell = new PythonShell(path.basename(scriptPath), options);
              const output: string[] = [];

              pyshell.on('message', (message: string) => {
                output.push(message);
              });

              pyshell.end((err: Error | null) => {
                if (err) reject(err);
                else resolve(output);
              });
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Execution timeout')), this.config.execution.timeoutMs)
            ),
          ]);
        } else {
          // For scripts without input data, use the command line approach
          const command = `${activateCmd}python "${scriptPath}"`;
          this.logger.info('Executing Python script with command', { command });

          // Set execution options
          const execOptions = {
            timeout: this.config.execution.timeoutMs,
            env: { ...process.env },
            ...(isWindows ? { shell: 'cmd.exe' } : {})
          };

          const { stdout, stderr } = await execAsync(command, execOptions);

          if (stderr) {
            this.logger.info('Stderr during Python execution', { stderr });
          }

          results = stdout.split('\n');
        }

        // Clean up temporary file if we created one
        if (isTemporaryScript) {
          await fs.unlink(scriptPath).catch(
            (err) => this.logger.error('Failed to clean up temp file', { error: err.message })
          );
        }

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
              mediaType: 'text/plain'
            },
            {
              type: 'text',
              text: JSON.stringify({
                executionTime: `${endTime - startTime}ms`,
                memoryUsage: `${memoryUsage.toFixed(2)} MB`
              }, null, 2),
              mediaType: 'application/json'
            }
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
              mediaType: 'text/plain'
            },
            {
              type: 'text',
              text: JSON.stringify({
                errorType: error instanceof Error ? error.constructor.name : 'Unknown',
                executionTime: `${endTime - startTime}ms`,
                memoryUsage: `${memoryUsage.toFixed(2)} MB`
              }, null, 2),
              mediaType: 'application/json'
            }
          ],
          isError: true,
        };
      } finally {
        this.activeExecutions--;
      }
    }); // End of withVenvLock
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

  /**
   * Ensures only one operation happens on the virtual environment at a time.
   * This is crucial for preventing race conditions when multiple operations
   * attempt to modify the virtual environment simultaneously.
   */
  private async withVenvLock<T>(operation: () => Promise<T>): Promise<T> {
    // Wait for any existing lock
    while (this.venvLockPromise) {
      try {
        await this.venvLockPromise;
      } catch {
        // Ignore errors in the previous lock, just wait for it to settle
      }
    }

    // Create a new lock (promise) for this operation
    let releaseLock!: () => void;
    this.venvLockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    this.logger.debug('Acquired single venv lock');

    try {
      // Execute the actual operation
      const result = await operation();
      return result;
    } finally {
      // Release the lock and remove it from the map
      releaseLock();
      this.venvLockPromise = null;
      this.logger.debug('Released single venv lock');
    }
  }

  /**
   * Get the path to the single virtual environment
   * 
   * @param venvName Optional name of the virtual environment (currently ignored)
   * @returns Absolute path to the virtual environment directory
   * @throws ExecutorError if the path is invalid
   */
  private getVenvPath(venvName?: string): string {
    const venvPath = path.resolve(this.config.python.venvPath);
    
    // Basic validation for the path
    if (!venvPath) {
      throw new ExecutorError(ErrorCode.INTERNAL_ERROR, `Virtual environment path is not configured.`);
    }
    
    return venvPath;
  }

  /**
   * Get activation command and python executable path for the virtual environment
   * 
   * @returns Object containing activation command, Windows flag, and python executable path
   */
  private getActivationPrefix(): { activateCmd: string, isWindows: boolean, pythonExecutable: string } {
    const venvPath = this.getVenvPath();
    const isWindows = os.platform() === 'win32';
    let activateCmd = '';
    let pythonExecutable = '';

    if (isWindows) {
        activateCmd = `"${path.join(venvPath, 'Scripts', 'activate.bat')}" && `;
        pythonExecutable = path.join(venvPath, 'Scripts', 'python.exe');
    } else {
        // Use 'source' for activating shell scripts in Unix environments
        activateCmd = `source "${path.join(venvPath, 'bin', 'activate')}" && `;
        pythonExecutable = path.join(venvPath, 'bin', 'python');
    }
    return { activateCmd, isWindows, pythonExecutable };
  }

  /**
   * Check if the virtual environment exists
   * 
   * @param venvName Optional name of the virtual environment (currently ignored)
   * @returns Promise that resolves to true if the venv exists, false otherwise
   */
  private async checkVenvExists(venvName?: string): Promise<boolean> {
    try {
      // Get validated venv path
      const venvPath = this.getVenvPath();
      
      // Look for pyvenv.cfg which indicates a valid virtual environment
      const cfgPath = path.join(venvPath, 'pyvenv.cfg');
      
      // Also check for the python executable to ensure venv is complete
      const isWindows = os.platform() === 'win32';
      const pythonPath = path.join(
        venvPath, 
        isWindows ? 'Scripts/python.exe' : 'bin/python'
      );
      
      // Check for both configuration and executable
      await Promise.all([
        fs.access(cfgPath, fs.constants.F_OK),
        fs.access(pythonPath, fs.constants.F_OK | fs.constants.X_OK)
      ]);
      
      this.logger.debug('Virtual environment exists and appears valid', { venvPath });
      return true;
    } catch (error) {
      this.logger.debug('Virtual environment does not exist or is incomplete', { venvPath: this.config.python.venvPath });
      return false;
    }
  }

  /**
   * Creates or ensures the virtual environment exists and is ready for use
   * 
   * @param venvName Optional name of the virtual environment (currently ignored)
   * @returns Promise that resolves when the virtual environment is ready
   * @throws Error if the virtual environment cannot be created
   */
  private async setupVirtualEnvironment(venvName?: string): Promise<void> {
    // Wrap the core logic in the lock to prevent concurrent creation attempts
    return this.withVenvLock(async () => {
      // Get validated path
      const venvPath = this.getVenvPath();
      this.logger.debug('Attempting to setup virtual environment', { path: venvPath });

      // Check if the venv already exists
      const venvExists = await this.checkVenvExists();

      if (!venvExists) {
        this.logger.info('Creating virtual environment', { path: venvPath });
        
        // Ensure parent directories exist
        await fs.mkdir(path.dirname(venvPath), { recursive: true });

        // Use system's python to create the venv with pip
        try {
          // Create venv with pip support and without site packages (for isolation)
          const createCmd = `python -m venv --clear --without-pip "${venvPath}"`;
          await execAsync(createCmd);
          
          // Install pip using the ensurepip module
          const { activateCmd, isWindows } = this.getActivationPrefix();
          const pipInstallCmd = `${activateCmd}python -m ensurepip --upgrade`;
          
          // For Windows, we need to use cmd.exe to properly handle the activation
          const execOptions = {
            timeout: this.config.execution.packageTimeoutMs,
            env: { ...process.env },
            ...(isWindows ? { shell: 'cmd.exe' } : {})
          };
          
          await execAsync(pipInstallCmd, execOptions);
          
          this.logger.info('Successfully created virtual environment with pip', { path: venvPath });
        } catch (error) {
          this.logger.error('Failed to create virtual environment', { 
            path: venvPath, 
            error: error instanceof Error ? error.message : String(error) 
          });
          
          // Attempt to clean up potentially incomplete venv directory
          await fs.rm(venvPath, { recursive: true, force: true }).catch(rmErr => {
            this.logger.error('Failed to cleanup incomplete venv directory', { 
              path: venvPath, 
              error: rmErr instanceof Error ? rmErr.message : String(rmErr) 
            });
          });
          
          throw new ExecutorError(
            ErrorCode.INTERNAL_ERROR, 
            `Failed to create virtual environment: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        this.logger.debug('Virtual environment already exists', { path: venvPath });
      }
    });
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

      // Setup virtual environment (create if needed)
      await this.setupVirtualEnvironment();

      // Check for UV package installer (but DO NOT automatically install it)
      try {
        await execAsync('uv --version');
      } catch (error) {
        this.logger.error('UV package installer not found', { error: error instanceof Error ? error.message : String(error) });
        throw new ExecutorError(
          ErrorCode.PACKAGE_INSTALLATION_ERROR,
          'UV package installer is required but not found. Please install UV manually: https://github.com/astral-sh/uv'
        );
      }

      // Convert input to array of packages
      const packagesArray = typeof args.packages === 'string'
        ? args.packages.split(',').map(p => p.trim()).filter(p => p)
        : args.packages;

      // Log the packages to be installed
      this.logger.info('Preparing to install packages', {
        packagesCount: packagesArray.length,
        packages: packagesArray
      });

      // Check for packages that commonly have wheel build issues
      const packagesWithPotentialWheelIssues = packagesArray.filter(pkg => {
        const pkgName = pkg.split(/[=<>~!]/)[0].trim().toLowerCase();
        // List of packages known to have wheel build issues with resource files
        const problematicPackages = [
          'pybullet', 'gym', 'mujoco', 'pytorch3d', 'open3d', 'pycocotools',
          'dgl', 'pyarrow', 'tensorflow', 'torch', 'torchvision', 'torchaudio'
        ];
        return problematicPackages.some(p => pkgName === p || pkgName.includes(p));
      });

      if (packagesWithPotentialWheelIssues.length > 0) {
        this.logger.info('Detected packages that may have wheel build issues', {
          packages: packagesWithPotentialWheelIssues
        });
      }

      // Install packages with UV - ensure proper quoting for package names with special characters
      const packages = packagesArray.map(pkg => `"${pkg.replace(/"/g, '\\"')}"`).join(' ');

      // Get activation details for the virtual environment
      const { activateCmd, isWindows } = this.getActivationPrefix();
      let command = '';
      let fallbackCommand = '';

      // Construct command with proper activation
      command = `${activateCmd}uv pip install ${packages}`;
      
      // Fallback command with --no-binary for problematic packages
      if (packagesWithPotentialWheelIssues.length > 0) {
        const noBinaryFlags = packagesWithPotentialWheelIssues
          .map(pkg => pkg.split(/[=<>~!]/)[0].trim())
          .map(pkg => `--no-binary=${pkg}`)
          .join(' ');
        fallbackCommand = `${activateCmd}uv pip install ${noBinaryFlags} ${packages}`;
      }

      this.logger.info('Installing packages with command', { command });

      // For Windows, we need to use cmd.exe to properly handle the activation
      const execOptions = {
        timeout: this.config.execution.packageTimeoutMs,
        env: { ...process.env },
        ...(isWindows ? { shell: 'cmd.exe' } : {})
      };

      let stdout = '';
      let stderr = '';
      let wheelBuildIssueDetected = false;

      try {
        const result = await execAsync(command, execOptions);
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (installError) {
        // Check if the error is related to wheel building
        const errorMessage = installError instanceof Error ? installError.message : String(installError);
        const stdoutStr = installError instanceof Error && 'stdout' in installError
          ? String((installError as any).stdout)
          : '';
        const stderrStr = installError instanceof Error && 'stderr' in installError
          ? String((installError as any).stderr)
          : '';

        // Combine all output for analysis
        const combinedOutput = `${errorMessage} ${stdoutStr} ${stderrStr}`;

        // Check for common wheel build error patterns
        const wheelBuildErrorPatterns = [
          /error: invalid command 'bdist_wheel'/i,
          /failed building wheel for/i,
          /command errored out/i,
          /could not build wheels/i,
          /error: could not build/i,
          /error: [^ ]+ extension/i,
          /error in [^ ]+ setup command/i,
          /resource files/i
        ];

        wheelBuildIssueDetected = wheelBuildErrorPatterns.some(pattern =>
          pattern.test(combinedOutput)
        );

        if (wheelBuildIssueDetected && fallbackCommand) {
          this.logger.info('Wheel build issue detected, trying fallback installation method', {
            fallbackCommand,
            error: errorMessage
          });

          try {
            // Try the fallback command with --no-binary flags
            const fallbackResult = await execAsync(fallbackCommand, execOptions);
            stdout = fallbackResult.stdout;
            stderr = fallbackResult.stderr;
            this.logger.info('Fallback installation succeeded', {
              packages: packagesWithPotentialWheelIssues
            });
          } catch (fallbackError) {
            // If fallback also fails, try installing packages one by one
            this.logger.error('Fallback installation failed, trying packages individually', {
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            });

            // Collect outputs from individual installations
            const individualResults: { package: string; success: boolean; output: string }[] = [];

            for (const pkg of packagesArray) {
              try {
                const pkgName = pkg.split(/[=<>~!]/)[0].trim();
                const isProblematic = packagesWithPotentialWheelIssues.some(p =>
                  p.split(/[=<>~!]/)[0].trim() === pkgName
                );

                let individualCommand = '';
                if (isWindows) {
                  individualCommand = `${activateCmd} && uv pip install ${isProblematic ? '--no-binary=' + pkgName : ''} "${pkg.replace(/"/g, '\\"')}"`;
                } else {
                  individualCommand = `${activateCmd} && uv pip install ${isProblematic ? '--no-binary=' + pkgName : ''} "${pkg.replace(/"/g, '\\"')}"`;
                }

                this.logger.info(`Installing package individually: ${pkg}`, { command: individualCommand });

                const result = await execAsync(individualCommand, execOptions);
                individualResults.push({
                  package: pkg,
                  success: true,
                  output: result.stdout + (result.stderr ? `\nWarnings/Errors:\n${result.stderr}` : '')
                });
              } catch (individualError) {
                individualResults.push({
                  package: pkg,
                  success: false,
                  output: individualError instanceof Error ? individualError.message : String(individualError)
                });
              }
            }

            // Combine outputs from individual installations
            stdout = individualResults
              .map(r => `Package: ${r.package}\nStatus: ${r.success ? 'Success' : 'Failed'}\n${r.output}`)
              .join('\n\n');
            stderr = `Some packages failed to install. See individual results above.`;
          }
        } else {
          // Re-throw if it's not a wheel build issue or we don't have a fallback
          throw installError;
        }
      }

      // Log the output for debugging
      this.logger.info('Package installation output', {
        stdout: stdout.substring(0, 500), // Limit log size
        stderr: stderr ? stderr.substring(0, 500) : null
      });

      this.logger.info('Packages installed successfully with UV', { packages: packagesArray });

      // Verify installation by getting the updated list of installed packages
      const installedPackages = await this.getInstalledPackages();

      // Check if all requested packages are installed
      const installedNames = Object.keys(installedPackages).map(name => name.toLowerCase());

      // Log all installed packages for debugging
      this.logger.info('All installed packages after installation', {
        count: installedNames.length,
        packages: installedNames.slice(0, 20).join(', ') + (installedNames.length > 20 ? '...' : '')
      });

      const requestedPackages = packagesArray.map(pkg => {
        // Extract package name without version specifiers
        const match = pkg.match(/^([^=<>~!]+)/);
        const packageName = match ? match[1].trim().toLowerCase() : pkg.toLowerCase();
        return packageName;
      });

      // Log the normalized requested package names
      this.logger.info('Normalized requested package names', {
        packages: requestedPackages
      });

      // Check for missing packages with more detailed logging
      const missingPackages: string[] = [];
      const installedDetails: string[] = [];

      for (const pkg of requestedPackages) {
        const isInstalled = installedNames.includes(pkg);

        if (!isInstalled) {
          // Try to find similar package names that might have been installed
          const similarPackages = installedNames.filter(name =>
            name.includes(pkg) || pkg.includes(name)
          ).slice(0, 5);

          missingPackages.push(pkg);
          this.logger.error(`Package "${pkg}" not found after installation`, {
            similarPackagesFound: similarPackages
          });
        } else {
          const version = installedPackages[pkg] ||
            installedPackages[Object.keys(installedPackages).find(
              name => name.toLowerCase() === pkg.toLowerCase()
            ) || 'unknown'];

          installedDetails.push(`${pkg}: ${version}`);
        }
      }

      if (missingPackages.length > 0) {
        this.logger.error('Some packages were not found after installation', {
          missing: missingPackages,
          installed: installedDetails
        });
      } else {
        this.logger.info('Verified all packages were installed successfully', {
          installed: installedDetails
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: stdout + (stderr ? `\nWarnings/Errors:\n${stderr}` : ''),
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: missingPackages.length > 0 ? 'partial' : 'success',
              packagesRequested: packagesArray,
              packagesInstalled: packagesArray.filter(pkg => {
                const normalizedName = pkg.match(/^([^=<>~!]+)/) ?
                  pkg.match(/^([^=<>~!]+)/)![1].trim().toLowerCase() :
                  pkg.toLowerCase();
                return !missingPackages.includes(normalizedName);
              }),
              environment: 'virtual environment',
              wheelBuildIssues: {
                detected: wheelBuildIssueDetected,
                packagesWithPotentialIssues: packagesWithPotentialWheelIssues,
                fallbackStrategyUsed: wheelBuildIssueDetected
              },
              verificationResults: {
                allPackagesInstalled: missingPackages.length === 0,
                missingPackages: missingPackages,
                installedDetails: installedDetails,
                totalInstalled: installedDetails.length,
                totalRequested: requestedPackages.length
              }
            }, null, 2),
            mediaType: 'application/json'
          }
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
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
              packagesRequested: args.packages
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true,
      };
    }
  }

  /**
   * Tool handler for analyze_code - analyzes Python code in the virtual environment
   * 
   * @param args - Arguments including code and analysis options
   * @returns Analysis results for security, style, and complexity
   */
  private async handleAnalyzeCode(args: any) {
    if (!args?.code || typeof args.code !== 'string') {
      throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Invalid code analysis arguments');
    }

    try {
      const results: any = {
        security: null,
        style: null,
        complexity: null,
      };

      // Create temporary file for analysis
      const scriptPath = path.join(this.tempDir, `analysis_${Date.now()}.py`);
      await fs.writeFile(scriptPath, args.code);

      try {
        // Ensure the virtual environment exists
        await this.setupVirtualEnvironment();
        
        // Get activation details for the virtual environment
        const { activateCmd, isWindows } = this.getActivationPrefix();

        // Create a Python script that will run the analysis
        // This avoids PATH issues by running the analysis modules directly
        const analysisScriptPath = path.join(this.tempDir, `run_analysis_${Date.now()}.py`);

        const analysisScript = `
import json
import sys
import os
import traceback

# Configure error reporting
def report_error(module_name, error):
    return {
        "error": str(error),
        "traceback": traceback.format_exc(),
        "module": module_name
    }

results = {
    "security": None,
    "style": None, 
    "complexity": None,
    "errors": []
}

code_path = "${scriptPath.replace(/\\/g, '\\\\')}"

# Security analysis with bandit
if ${this.config.python.analysis.enableSecurity && args.enableSecurity !== false}:
    try:
        import bandit
        from bandit.core import manager
        
        # Configure bandit programmatically
        b_mgr = manager.BanditManager(
            config_file=None,
            agg_type='file',
            debug=False,
            verbose=False,
            quiet=True,
            profile=None,
            ignore_nosec=False
        )
        
        # Run the scan
        b_mgr.discover_files([code_path])
        b_mgr.run_tests()
        
        # Convert results to JSON
        results["security"] = {
            "results": [issue.to_dict() for issue in b_mgr.get_issue_list()],
            "stats": b_mgr.metrics.data
        }
    except ImportError as e:
        results["errors"].append(report_error("bandit", f"Bandit module not installed: {e}"))
    except Exception as e:
        results["errors"].append(report_error("bandit", f"Bandit analysis failed: {e}"))

# Style analysis with pylint
if ${this.config.python.analysis.enableStyle && args.enableStyle !== false}:
    try:
        from pylint import lint
        from pylint.reporters.json_reporter import JSONReporter
        from io import StringIO
        import json
        
        output = StringIO()
        reporter = JSONReporter(output)
        
        # Run pylint
        lint.Run([code_path, "--output-format=json"], reporter=reporter, exit=False)
        
        # Get the output
        json_output = output.getvalue()
        if json_output.strip():
            results["style"] = json.loads(json_output)
        else:
            results["style"] = []
    except ImportError as e:
        results["errors"].append(report_error("pylint", f"Pylint module not installed: {e}"))
    except Exception as e:
        results["errors"].append(report_error("pylint", f"Pylint analysis failed: {e}"))

# Complexity analysis with radon
if ${this.config.python.analysis.enableComplexity && args.enableComplexity !== false}:
    try:
        import radon.complexity as cc
        import json
        
        # Analyze complexity
        with open(code_path, 'r') as f:
            code = f.read()
        
        blocks = cc.cc_visit(code)
        complexity_data = {}
        
        # Convert blocks to dictionary
        complexity_data[code_path] = [
            {
                "name": block.name,
                "complexity": block.complexity,
                "lineno": block.lineno,
                "endline": getattr(block, 'endline', block.lineno),
                "type": block.type
            }
            for block in blocks
        ]
        
        results["complexity"] = complexity_data
    except ImportError as e:
        results["errors"].append(report_error("radon", f"Radon module not installed: {e}"))
    except Exception as e:
        results["errors"].append(report_error("radon", f"Radon analysis failed: {e}"))

# Add environment information
results["environment"] = {
    "python_version": sys.version,
    "platform": sys.platform,
    "modules_found": {
        "bandit": "bandit" in sys.modules,
        "pylint": "pylint" in sys.modules,
        "radon": "radon" in sys.modules
    }
}

# Output results as JSON
print(json.dumps(results, indent=2))
`;

        await fs.writeFile(analysisScriptPath, analysisScript);

        // Execute the analysis script
        const execOptions = {
          timeout: this.config.execution.timeoutMs,
          env: { ...process.env },
          ...(isWindows && this.config.python.useVirtualEnv ? { shell: 'cmd.exe' } : {})
        };

        // Use proper activation command
        const command = `${activateCmd}python "${analysisScriptPath}"`;
        this.logger.info('Running code analysis with command', { command });

        const { stdout, stderr } = await execAsync(command, execOptions);

        if (stderr) {
          this.logger.info('Stderr during code analysis', { stderr });
        }

        // Parse the results
        try {
          const analysisResults = JSON.parse(stdout);
          results.security = analysisResults.security;
          results.style = analysisResults.style;
          results.complexity = analysisResults.complexity;

          // Log any errors encountered
          if (analysisResults.errors && analysisResults.errors.length > 0) {
            this.logger.error('Analysis module errors', { errors: analysisResults.errors });

            // Add errors to the response
            results.errors = analysisResults.errors;
          }

          // Log environment info
          if (analysisResults.environment) {
            this.logger.info('Analysis environment', { environment: analysisResults.environment });
          }
          
          // Add virtual environment info to results
          results.virtualEnvironment = {
            path: this.getVenvPath()
          };
        } catch (parseError) {
          this.logger.error('Error parsing analysis results', {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            stdout
          });
        }

        // Clean up analysis script
        await fs.unlink(analysisScriptPath).catch(
          err => this.logger.error('Failed to clean up analysis script', { error: err.message })
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
              mediaType: 'application/json'
            },
            {
              type: 'text',
              text: this.generateAnalysisSummary(results),
              mediaType: 'text/plain'
            }
          ],
        };
      } finally {
        // Clean up the code file
        await fs.unlink(scriptPath).catch(
          err => this.logger.error('Failed to clean up analysis source file', { error: err.message })
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Code analysis error', { error: errorMessage });

      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing code: ${errorMessage}`,
            mediaType: 'text/plain'
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
              errorDetails: errorMessage
            }, null, 2),
            mediaType: 'application/json'
          }
        ],
        isError: true,
      };
    }
  }

  /**
   * Generate a human-readable summary of code analysis results
   */
  private generateAnalysisSummary(results: any): string {
    let summary = 'Code Analysis Summary:\n\n';

    // Helper function to escape Unicode characters
    const ensureAscii = (str: string): string => {
      return str.replace(/[^\x00-\x7F]/g, '');
    };

    if (results.security) {
      const issues = results.security.results || [];
      summary += `Security: ${issues.length} issue(s) found\n`;

      if (issues.length > 0) {
        summary += 'Top issues:\n';
        issues.slice(0, 3).forEach((issue: any, index: number) => {
          summary += `  ${index + 1}. ${ensureAscii(issue.issue_text || 'Unknown issue')} (Severity: ${issue.issue_severity || 'unknown'})\n`;
        });
        summary += '\n';
      }
    }

    if (results.style) {
      const issues = results.style || [];
      summary += `Style: ${issues.length} issue(s) found\n`;

      if (issues.length > 0) {
        summary += 'Top issues:\n';
        issues.slice(0, 3).forEach((issue: any, index: number) => {
          summary += `  ${index + 1}. ${ensureAscii(issue.message || 'Unknown issue')} (Line: ${issue.line || 'unknown'})\n`;
        });
        summary += '\n';
      }
    }

    if (results.complexity) {
      const files = Object.keys(results.complexity || {});
      let totalComplexity = 0;
      let functionCount = 0;

      files.forEach(file => {
        const functions = results.complexity[file] || [];
        functionCount += functions.length;
        functions.forEach((func: any) => {
          totalComplexity += func.complexity || 0;
        });
      });

      const avgComplexity = functionCount > 0 ? (totalComplexity / functionCount).toFixed(1) : 0;
      summary += `Complexity: ${functionCount} function(s) analyzed with average complexity of ${avgComplexity}\n`;

      if (functionCount > 0) {
        summary += 'Most complex functions:\n';
        let allFunctions: any[] = [];

        files.forEach(file => {
          const functions = results.complexity[file] || [];
          allFunctions = allFunctions.concat(functions);
        });

        allFunctions.sort((a, b) => (b.complexity || 0) - (a.complexity || 0));

        allFunctions.slice(0, 3).forEach((func: any, index: number) => {
          summary += `  ${index + 1}. ${ensureAscii(func.name || 'Unknown')} (Complexity: ${func.complexity || 'unknown'})\n`;
        });
      }
    }

    return summary;
  }

  async run() {
    console.log("STARTUP: Beginning server run method");
    try {
      console.log("STARTUP: Creating StdioServerTransport");
      const transport = new StdioServerTransport();
      console.log("STARTUP: Calling server.connect with transport");
      await this.server.connect(transport);
      console.log("STARTUP: Python Executor MCP server running on stdio");
      this.logger.info('Python Executor MCP server running on stdio');
    } catch (error) {
      console.log(`CRITICAL ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`);
      console.log(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
      process.exit(1);
    }
  }
}

const server = new PythonExecutorServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
