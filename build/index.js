#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode as McpErrorCode, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from './config.js';
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
const isValidExecuteArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        (typeof args.code === 'string' || typeof args.scriptPath === 'string') &&
        (args.inputData === undefined ||
            (Array.isArray(args.inputData) &&
                args.inputData.every((item) => typeof item === 'string'))) &&
        (args.venvName === undefined || typeof args.venvName === 'string'));
};
const isValidInstallArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        (typeof args.packages === 'string' ||
            (Array.isArray(args.packages) &&
                args.packages.every((pkg) => typeof pkg === 'string'))) &&
        (args.venvName === undefined || typeof args.venvName === 'string'));
};
const isValidVenvArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        typeof args.venvName === 'string' &&
        (args.description === undefined || typeof args.description === 'string') &&
        (args.confirm === undefined || typeof args.confirm === 'boolean') &&
        (args.pythonVersion === undefined || typeof args.pythonVersion === 'string'));
};
const isValidExecutePythonFileArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        typeof args.filePath === 'string' &&
        (args.venvName === undefined || typeof args.venvName === 'string') &&
        (args.inputData === undefined ||
            (Array.isArray(args.inputData) &&
                args.inputData.every((item) => typeof item === 'string'))));
};
class PythonExecutorServer {
    constructor() {
        this.activeExecutions = 0;
        // Define available prompts with type safety
        this.PROMPTS = {
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
            },
            'create-venv': {
                name: 'create-venv',
                description: 'Guide for creating Python virtual environments',
                arguments: [
                    {
                        name: 'purpose',
                        description: 'The purpose or type of project this environment will be used for',
                        required: true
                    },
                    {
                        name: 'python_version',
                        description: 'Specific Python version required (if any)',
                        required: false
                    }
                ]
            }
        };
        console.error("STARTUP: Beginning server construction");
        try {
            this.server = new Server({
                name: 'mcp-python-executor',
                version: '0.3.1', // Update version from 0.2.0 to 0.3.1
                capabilities: {
                    prompts: {},
                    tools: {}
                }
            });
            console.error("STARTUP: Created server instance");
            // Set up handlers - these can be set up before config is loaded
            this.setupPromptHandlers();
            this.setupToolHandlers();
            console.error("STARTUP: Set up handlers"); // Use console.error since logger isn't initialized yet
            // Error handling - can be set up early
            this.server.onerror = (error) => {
                this.logger?.error?.('MCP Error', { error }); // Use optional chaining
            };
            process.on('SIGINT', async () => {
                await this.server.close();
                process.exit(0);
            });
            console.error("STARTUP: Server construction completed successfully (basic setup)");
            // The rest of the initialization that depends on config is moved to run()
        }
        catch (error) {
            console.error(`CRITICAL STARTUP ERROR: ${error instanceof Error ? error.message : String(error)}`);
            console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
            throw error;
        }
    }
    async getPythonVersion() {
        try {
            const { stdout } = await execAsync('python --version');
            return stdout.trim();
        }
        catch (error) {
            this.logger?.error?.('Failed to get Python version', { error });
            return 'unknown';
        }
    }
    /**
     * Initialize the default virtual environment with pre-configured packages
     */
    async initializePreinstalledPackages() {
        const packages = Object.keys(this.config.python.packages);
        if (packages.length > 0) {
            try {
                this.logger?.info?.('Installing pre-configured packages in virtual environment', {
                    packages
                });
                // Install packages in the environment
                await this.handleInstallPackages({
                    packages
                });
                this.logger?.info?.('Pre-configured packages installed successfully in virtual environment');
            }
            catch (error) {
                this.logger?.error?.('Error installing pre-configured packages', {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        else {
            this.logger?.info?.('No packages configured for preinstallation');
        }
    }
    setupPromptHandlers() {
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
                                text: `Task: ${task}\nRequirements: ${requirements}\n\n⚠️ CRITICAL DEPENDENCY WARNING ⚠️\n\nBEFORE executing ANY Python code, you MUST:\n1. Check installed packages using 'list_packages' tool\n2. Install missing dependencies using 'install_packages' tool\n3. ONLY then use 'execute_python'\n\n⚠️ NEVER SKIP THIS WORKFLOW. Module not found errors are almost always caused by missing dependencies!\n\n### IMPORTANT: Handling Output Files ###\nIf your code saves any files (like plots, data files, etc.), you MUST specify an output directory that the Executor can write to.\nThe recommended way is to:\n1. Obtain the desired output directory path from the user or your context.\n2. Pass this path to the 'execute_python' tool call as an environment variable named 'OUTPUT_PATH'.\n3. Include the following Python code snippet at the beginning of your script to read the path and ensure the directory exists:\n\`\`\`python\nimport os\nimport pathlib\n\n# Get the output directory from the environment variable 'OUTPUT_PATH'\n# Default to the current working directory '.' if the variable is not set.\noutput_dir = os.environ.get('OUTPUT_PATH', '.')\n\n# Create the directory if it doesn't exist, including any parent directories.\n# exist_ok=True prevents an error if the directory already exists.\npathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)\n\n# Print the output directory for confirmation (optional)\nprint(f"Using output directory: {output_dir}")\n\`\`\`\n4. Use \`os.path.join(output_dir, 'your_filename.extension')\` for all file saving operations.\n**Failure to use a writable path obtained via 'OUTPUT_PATH' may result in a Read-only file system error.**\n\nPlease help me write Python code that:`
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
                                    + '\n3. Determine the optimal installation order'
                                    + '\n4. Suggest best practices for package management'
                            }
                        }
                    ]
                };
            }
            if (request.params.name === 'create-venv') {
                const purpose = request.params.arguments?.purpose || '';
                const pythonVersion = request.params.arguments?.python_version || '';
                return {
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Purpose: ${purpose}\nPython Version: ${pythonVersion}\n\n🔹 Virtual Environment Creation Guide 🔹\n\nI'll help you create a Python virtual environment optimized for: ${purpose}\n\n⚠️ IMPORTANT NEW FEATURES ⚠️\n\n1. **Python Version Specification**:\n   - You can now specify which Python version to use when creating an environment\n   - Use the 'pythonVersion' parameter with the 'create_venv' tool\n   - For macOS users:\n     * For Python 3.13: Use \`"pythonVersion": "3.13"\`\n     * For other versions: Use the full path like \`"pythonVersion": "/opt/homebrew/bin/python3.12"\`\n   - If not specified, the system default Python will be used\n\n2. **Automatic pip Upgrade**:\n   - All newly created environments will have pip automatically upgraded to the latest version\n   - This ensures compatibility with modern packages and security fixes\n   - No additional steps required - this happens automatically\n\nTo create a ${pythonVersion ? 'Python ' + pythonVersion : ''} virtual environment for ${purpose}, follow these steps:\n\n1. Use the 'create_venv' tool with these parameters:\n   - venvName: Choose a descriptive name related to your project\n   - description: Briefly describe the environment's purpose\n${pythonVersion ? '   - pythonVersion: "' + pythonVersion + '" (as specified)\n' : '   - pythonVersion: Optional - specify if you need a particular Python version\n'}\n2. After creation, install required packages using 'install_packages'\n3. Verify installation with 'list_packages'\n4. Execute your code with 'execute_python', specifying the environment name\n\nThis will create an isolated environment with ${pythonVersion || 'the system default Python'} and the latest pip version.`
                            }
                        }
                    ]
                };
            }
            throw new McpError(McpErrorCode.InvalidRequest, 'Prompt implementation not found');
        });
    }
    setupToolHandlers() {
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

⚠️ IMPORTANT: For File Output Operations ⚠️
If your Python code saves files (plots, data, etc.), you MUST:
1. Include the following snippet at the beginning of your code:
   import os
   import pathlib
   output_dir = os.environ.get('OUTPUT_PATH', '.')
   pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)
2. Use os.path.join(output_dir, 'filename.ext') for all file paths
3. Set the OUTPUT_PATH environment variable before execution
Failure to use this pattern may result in "Read-only file system" errors!

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
  "code": "import numpy as np\\nimport os\\nimport pathlib\\n\\noutput_dir = os.environ.get('OUTPUT_PATH', '.')\\npathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)\\n\\ntry:\\n    data = np.random.rand(3,3)\\n    print(data)\\n    # Save to file example:\\n    # np.save(os.path.join(output_dir, 'random_data.npy'), data)\\nexcept Exception as e:\\n    print(f'Error: {e}')",
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
- **Allows specifying the Python version to use**
- **Automatically upgrades pip after creation**

Example usage:
{
  "venvName": "data-science",
  "description": "Environment for data science projects with numpy and pandas",
  "pythonVersion": "3.13" // For Python 3.13 on macOS
}

For macOS users with other Python versions, use the full path:
{
  "venvName": "data-science-py312",
  "description": "Environment for data science with Python 3.12",
  "pythonVersion": "/opt/homebrew/bin/python3.12" // Full path for other versions
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
                            },
                            pythonVersion: {
                                type: 'string',
                                description: 'Optional Python version to use for the virtual environment. On macOS, use "3.13" for Python 3.13 or the full path like "/opt/homebrew/bin/python3.12" for other versions. Defaults to the system default.',
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
                    name: 'execute_python_file',
                    description: `Execute a Python file within a specified virtual environment.

⚠️ CRITICAL DEPENDENCY WARNING ⚠️
DO NOT USE THIS TOOL FIRST! ALWAYS CHECK AND INSTALL DEPENDENCIES FIRST!

Follow this exact workflow:
1. FIRST use 'list_packages' to check dependencies
2. THEN use 'install_packages' to install missing dependencies
3. ONLY AFTER DEPENDENCIES ARE INSTALLED use execute_python_file

Features:
- Execute an existing Python script file
- Use a specific virtual environment for execution
- Pass input data to the script via stdin
- Capture stdout and stderr
- Error handling and timeout protection

⚠️ IMPORTANT: For File Output Operations ⚠️
If your Python code saves files (plots, data, etc.), you MUST:
1. Include the following snippet at the beginning of your code:
   import os
   import pathlib
   output_dir = os.environ.get('OUTPUT_PATH', '.')
   pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)
2. Use os.path.join(output_dir, 'filename.ext') for all file paths
3. Set the OUTPUT_PATH environment variable before execution
Failure to use this pattern may result in "Read-only file system" errors!

Example usage:
{
  "filePath": "/path/to/your/existing_script.py",
  "venvName": "my-project-env",
  "inputData": ["line1", "line2"]
}`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: {
                                type: 'string',
                                description: 'The absolute or relative path to the Python file to execute.',
                            },
                            venvName: {
                                type: 'string',
                                description: 'Optional virtual environment name to use for execution. Defaults to the configured default venv.',
                            },
                            inputData: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                },
                                description: 'Optional array of input strings that will be available to the script via stdin',
                            }
                        },
                        required: ['filePath'],
                    },
                },
            ],
        }));
        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case 'execute_python':
                    return this.handleExecutePython(request.params.arguments);
                case 'execute_python_file':
                    return this.handleExecutePythonFile(request.params.arguments);
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
                default:
                    throw new McpError(McpErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async getInstalledPackages(venvName) {
        try {
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Create a temporary Python script to list packages
            const scriptPath = path.join(this.tempDir, `list_packages_${Date.now()}.py`);
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
            this.logger?.info?.('Created package listing script', { scriptPath });
            // Check if the virtual environment exists
            const venvExists = await this.venvManager.checkVenvExists(targetVenvName);
            if (!venvExists) {
                this.logger?.warn?.('Attempted to get packages from non-existent venv', { venvName: targetVenvName });
                throw new ExecutorError(ErrorCode.INVALID_INPUT, `Virtual environment does not exist: ${targetVenvName}`);
            }
            // Get activation details for the virtual environment
            const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(targetVenvName);
            // Use the Python executable from the virtual environment
            let command;
            if (isWindows) {
                // For Windows, we use cmd.exe to handle the activation
                command = `${activateCmd}python "${scriptPath}"`;
            }
            else {
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
            await fs.unlink(scriptPath).catch(err => this.logger?.error?.('Failed to clean up package listing script', { error: err.message }));
            if (stderr) {
                this.logger?.info?.('Stderr while getting packages', { stderr });
            }
            try {
                // Parse the JSON output
                const packagesRecord = JSON.parse(stdout);
                // Add debug log to see what packages were found
                this.logger?.info?.('Successfully retrieved installed packages', {
                    packageCount: Object.keys(packagesRecord).length,
                    packages: Object.keys(packagesRecord).join(', ')
                });
                return packagesRecord;
            }
            catch (parseError) {
                this.logger?.error?.('Failed to parse package list output', {
                    error: parseError instanceof Error ? parseError.message : String(parseError),
                    stdout
                });
                return {};
            }
        }
        catch (error) {
            this.logger?.error?.('Failed to get installed packages', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            return {}; // Return empty object in case of error
        }
    }
    /**
     * Handle list_venvs tool - lists all available virtual environments
     */
    async handleListVenvs() {
        try {
            const venvDetails = await this.venvManager.getVenvDetails();
            this.logger?.info?.('Listed venvs', { count: venvDetails.length });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            venvs: venvDetails
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ]
            };
        }
        catch (error) {
            const message = `Failed to list venvs: ${error.message}`;
            this.logger?.error?.(message, { error });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ],
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
    async handleCreateVenv(args) {
        if (!isValidVenvArgs(args)) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid venvName argument. Please provide a name for the virtual environment.');
        }
        const { venvName, description, pythonVersion } = args;
        try {
            // Create the virtual environment, passing the pythonVersion
            await this.venvManager.setupVirtualEnvironment(venvName, pythonVersion);
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
                            description: description || '',
                            pythonVersion: pythonVersion || 'system default'
                        }, null, 2),
                        mediaType: 'application/json'
                    }]
            };
        }
        catch (error) {
            this.logger?.error?.('Failed to create virtual environment', {
                venvName,
                pythonVersion,
                error: error.message || String(error)
            });
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message: `Failed to create virtual environment '${venvName}': ${error.message || 'Unknown error'}`,
                            venvName,
                            pythonVersion: pythonVersion || 'system default'
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
    async handleDeleteVenv(args) {
        if (!isValidVenvArgs(args)) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid venvName argument. Please provide the name of the virtual environment to delete.');
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
        }
        catch (error) {
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
            this.logger?.error?.('Failed to delete virtual environment', {
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
    async handleSetVenvDescription(args) {
        if (!isValidVenvArgs(args) || !args.description) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid arguments. Please provide venvName and description.');
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
        }
        catch (error) {
            this.logger?.error?.('Failed to update venv description', {
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
    async handleExecutePython(args) {
        try {
            // Validate input arguments
            if (!isValidExecuteArgs(args)) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid parameters. Please provide either code or scriptPath.');
            }
            // Extract venv name if provided
            const venvName = args.venvName;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Verify the environment exists or create it
            await this.venvManager.setupVirtualEnvironment(targetVenvName);
            // Increment counter for active executions
            this.activeExecutions++;
            try {
                // Get activation details for the virtual environment
                const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(targetVenvName);
                // Create a temporary file if code is provided inline
                let scriptPath = '';
                let tempFile = false;
                if (args.code) {
                    // Generate a unique filename to avoid conflicts with concurrent executions
                    const filename = `script_${Date.now()}_${Math.floor(Math.random() * 10000)}.py`;
                    scriptPath = path.join(this.tempDir, filename);
                    // Write the code to the temporary file
                    await fs.writeFile(scriptPath, args.code, 'utf-8');
                    tempFile = true;
                }
                else if (args.scriptPath) {
                    // Use the provided script path
                    scriptPath = args.scriptPath;
                    // Check if the file exists
                    await fs.access(scriptPath, fs.constants.F_OK)
                        .catch(() => {
                        throw new ExecutorError(ErrorCode.INVALID_INPUT, `Script file not found: ${scriptPath}`);
                    });
                }
                // Prepare input data if provided
                let inputData = '';
                if (args.inputData && Array.isArray(args.inputData)) {
                    inputData = args.inputData.join('\n') + '\n';
                }
                // Execute the script
                let stdout = '';
                let stderr = '';
                try {
                    if (isWindows) {
                        // On Windows, we need to use the shell with activation command
                        const command = `${activateCmd}python "${scriptPath}"`;
                        const execOptions = {
                            timeout: this.config.execution.timeoutMs,
                            env: { ...process.env },
                            shell: 'cmd.exe',
                            // Provide input data if available
                            input: inputData || undefined
                        };
                        const { stdout: procStdout, stderr: procStderr } = await execAsync(command, execOptions);
                        stdout = procStdout;
                        stderr = procStderr;
                    }
                    else {
                        // On Unix, we can use spawn directly with the Python executable
                        const pythonProcess = spawn(pythonExecutable, [scriptPath], {
                            timeout: this.config.execution.timeoutMs,
                            env: { ...process.env }
                        });
                        // Provide input data if available
                        if (inputData) {
                            pythonProcess.stdin.write(inputData);
                            pythonProcess.stdin.end();
                        }
                        // Collect stdout and stderr
                        pythonProcess.stdout.on('data', (data) => {
                            stdout += data.toString();
                        });
                        pythonProcess.stderr.on('data', (data) => {
                            stderr += data.toString();
                        });
                        // Wait for completion
                        await new Promise((resolve, reject) => {
                            pythonProcess.on('close', (code) => {
                                if (code === 0) {
                                    resolve();
                                }
                                else {
                                    // Non-zero exit code doesn't always mean an error in Python
                                    // Just store the exit code to return to the client
                                    stderr = `${stderr}\nProcess exited with code ${code}`;
                                    resolve();
                                }
                            });
                            pythonProcess.on('error', (err) => {
                                reject(err);
                            });
                        });
                    }
                }
                finally {
                    // Clean up the temporary file if we created one
                    if (tempFile && scriptPath) {
                        await fs.unlink(scriptPath).catch(err => {
                            this.logger?.warn?.('Failed to delete temporary script file', {
                                path: scriptPath,
                                error: err instanceof Error ? err.message : String(err)
                            });
                        });
                    }
                }
                // Extract Python error if present in stderr
                const errorMatch = stderr.match(/^(?:Traceback.*?^)([A-Za-z]+Error.+?)(?:\n|$)/ms);
                const hasError = !!errorMatch || stderr.includes('Error:') || stderr.includes('Exception:');
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                stdout,
                                stderr,
                                venvName: targetVenvName,
                                error: errorMatch ? errorMatch[1] : null,
                                hasError
                            }, null, 2),
                            mediaType: 'application/json'
                        }
                    ],
                    isError: hasError
                };
            }
            finally {
                // Decrement counter for active executions
                this.activeExecutions--;
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Python execution error', { error: errorMessage, venvName: args?.venvName });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message: `Error executing Python code: ${errorMessage}`,
                            venvName: args?.venvName || this.config.python.defaultVenvName
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ],
                isError: true
            };
        }
    }
    async handleExecutePythonFile(args) {
        try {
            // Validate input arguments
            if (!isValidExecutePythonFileArgs(args)) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid filePath parameter.');
            }
            const { filePath, venvName, inputData } = args;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Verify the environment exists or create it
            await this.venvManager.setupVirtualEnvironment(targetVenvName);
            // Increment counter for active executions
            this.activeExecutions++;
            try {
                // Get activation details for the virtual environment
                const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(targetVenvName);
                // Check if the file exists
                await fs.access(filePath, fs.constants.F_OK)
                    .catch(() => {
                    throw new ExecutorError(ErrorCode.INVALID_INPUT, `Python file not found: ${filePath}`);
                });
                // Prepare input data if provided
                let inputString = '';
                if (inputData && Array.isArray(inputData)) {
                    inputString = inputData.join('\n') + '\n';
                }
                // Execute the script
                let stdout = '';
                let stderr = '';
                try {
                    if (isWindows) {
                        // On Windows, use cmd.exe with activation command
                        const command = `${activateCmd}python "${filePath}"`;
                        const execOptions = {
                            timeout: this.config.execution.timeoutMs,
                            env: { ...process.env },
                            shell: 'cmd.exe',
                            // Provide input data if available
                            input: inputString || undefined
                        };
                        const { stdout: procStdout, stderr: procStderr } = await execAsync(command, execOptions);
                        stdout = procStdout;
                        stderr = procStderr;
                    }
                    else {
                        // On Unix, use spawn directly with the Python executable from the venv
                        const pythonProcess = spawn(pythonExecutable, [filePath], {
                            timeout: this.config.execution.timeoutMs,
                            env: { ...process.env }
                        });
                        // Provide input data if available
                        if (inputString) {
                            pythonProcess.stdin.write(inputString);
                            pythonProcess.stdin.end();
                        }
                        // Collect stdout and stderr
                        pythonProcess.stdout.on('data', (data) => {
                            stdout += data.toString();
                        });
                        pythonProcess.stderr.on('data', (data) => {
                            stderr += data.toString();
                        });
                        // Wait for completion
                        await new Promise((resolve, reject) => {
                            pythonProcess.on('close', (code) => {
                                if (code === 0) {
                                    resolve();
                                }
                                else {
                                    // Non-zero exit code doesn't always mean an error in Python
                                    // Just store the exit code to return to the client
                                    stderr = `${stderr}\nProcess exited with code ${code}`;
                                    resolve();
                                }
                            });
                            pythonProcess.on('error', (err) => {
                                reject(err);
                            });
                        });
                    }
                }
                finally {
                    // No temporary file to clean up as we are using a provided filePath
                }
                // Extract Python error if present in stderr
                const errorMatch = stderr.match(/^(?:Traceback.*?^)([A-Za-z]+Error.+?)(?:\n|$)/ms);
                const hasError = !!errorMatch || stderr.includes('Error:') || stderr.includes('Exception:');
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                stdout,
                                stderr,
                                venvName: targetVenvName,
                                error: errorMatch ? errorMatch[1] : null,
                                hasError
                            }, null, 2),
                            mediaType: 'application/json'
                        }
                    ],
                    isError: hasError
                };
            }
            finally {
                // Decrement counter for active executions
                this.activeExecutions--;
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Python file execution error', {
                error: errorMessage,
                filePath: args?.filePath,
                venvName: args?.venvName
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message: `Error executing Python file: ${errorMessage}`,
                            filePath: args?.filePath,
                            venvName: args?.venvName || this.config.python.defaultVenvName
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ],
                isError: true
            };
        }
    }
    async handleInstallPackages(args) {
        try {
            if (!isValidInstallArgs(args)) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid packages parameter. Please provide a comma-separated string or array of package names.');
            }
            // Extract venvName from args
            const venvName = args.venvName;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Ensure the virtual environment exists
            await this.venvManager.setupVirtualEnvironment(targetVenvName);
            let packagesArray = [];
            // Convert packages to array if it's a string
            if (typeof args.packages === 'string') {
                packagesArray = args.packages.split(/,\s*/).filter(Boolean);
            }
            else if (Array.isArray(args.packages)) {
                packagesArray = args.packages.filter(pkg => typeof pkg === 'string' && pkg.trim() !== '');
            }
            if (packagesArray.length === 0) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'No valid packages specified for installation.');
            }
            // Get installation packages before so we can check for successful installs
            const installedPackagesBefore = await this.getInstalledPackages(targetVenvName);
            // Get activation details for the virtual environment
            const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(targetVenvName);
            // Log installation request
            this.logger?.info?.('Installing packages', {
                packages: packagesArray,
                venvName: targetVenvName
            });
            // Install the packages
            let stdout = '';
            let stderr = '';
            try {
                if (isWindows) {
                    // On Windows, we need to use the shell with activation command
                    const packageList = packagesArray.map(pkg => `"${pkg.replace(/"/g, '\\"')}"`).join(' ');
                    const command = `${activateCmd}pip install ${packageList}`;
                    const execOptions = {
                        timeout: this.config.execution.packageTimeoutMs,
                        env: { ...process.env },
                        shell: 'cmd.exe'
                    };
                    const { stdout: procStdout, stderr: procStderr } = await execAsync(command, execOptions);
                    stdout = procStdout;
                    stderr = procStderr;
                }
                else {
                    // On Unix, we can use spawn directly with the Python executable
                    const installProcess = spawn(pythonExecutable, ['-m', 'pip', 'install', ...packagesArray], {
                        timeout: this.config.execution.packageTimeoutMs,
                        env: { ...process.env }
                    });
                    // Collect stdout and stderr
                    installProcess.stdout.on('data', (data) => {
                        stdout += data.toString();
                    });
                    installProcess.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                    // Wait for completion
                    await new Promise((resolve, reject) => {
                        installProcess.on('close', (code) => {
                            if (code === 0) {
                                resolve();
                            }
                            else {
                                reject(new Error(`Package installation failed with code ${code}: ${stderr}`));
                            }
                        });
                        installProcess.on('error', (err) => {
                            reject(err);
                        });
                    });
                }
                // Check which packages were actually installed
                const installedPackagesAfter = await this.getInstalledPackages(targetVenvName);
                // Make a list of newly installed packages and their versions
                const newPackages = {};
                for (const pkg in installedPackagesAfter) {
                    if (!installedPackagesBefore[pkg] || installedPackagesBefore[pkg] !== installedPackagesAfter[pkg]) {
                        newPackages[pkg] = installedPackagesAfter[pkg];
                    }
                }
                const newPackageCount = Object.keys(newPackages).length;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                message: `${newPackageCount} package(s) installed or updated`,
                                venvName: targetVenvName,
                                installedPackages: newPackages,
                                stdout: stdout.substring(0, 1000), // Limit output size
                                stderr: stderr.substring(0, 1000) // Limit output size
                            }, null, 2),
                            mediaType: 'application/json'
                        }
                    ]
                };
            }
            catch (error) {
                this.logger?.error?.('Package installation error', {
                    error: error instanceof Error ? error.message : String(error),
                    packages: packagesArray,
                    venvName: targetVenvName
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'error',
                                message: `Failed to install packages: ${error instanceof Error ? error.message : String(error)}`,
                                venvName: targetVenvName,
                                stdout: stdout.substring(0, 1000), // Limit output size
                                stderr: stderr.substring(0, 1000) // Limit output size
                            }, null, 2),
                            mediaType: 'application/json'
                        }
                    ],
                    isError: true
                };
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Package installation parameter error', { error: errorMessage });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message: `Error installing packages: ${errorMessage}`,
                            venvName: args?.venvName || this.config.python.defaultVenvName
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ],
                isError: true
            };
        }
    }
    async handleHealthCheck(args) {
        try {
            // Extract venvName from args if provided
            const venvName = args?.venvName;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Basic health information
            const healthInfo = {
                status: 'ok',
                server: 'mcp-python-executor',
                venvManager: 'initialized',
                activeExecutions: this.activeExecutions
            };
            // Add venv-specific information if a venvName is provided
            if (venvName) {
                const venvExists = await this.venvManager.checkVenvExists(targetVenvName);
                if (venvExists) {
                    healthInfo.venv = {
                        name: targetVenvName,
                        exists: true,
                        path: this.venvManager.getVenvPath(targetVenvName)
                    };
                    // Try to get the packages in this venv
                    try {
                        const packages = await this.getInstalledPackages(targetVenvName);
                        healthInfo.venv.packageCount = Object.keys(packages).length;
                    }
                    catch (pkgError) {
                        healthInfo.venv.packageCount = 'error';
                    }
                }
                else {
                    healthInfo.venv = {
                        name: targetVenvName,
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
        }
        catch (error) {
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
    async terminateExistingVenvProcesses() {
        try {
            const isWindows = os.platform() === 'win32';
            const venvPath = this.getVenvPath();
            // Find Python processes from this venv using safer command execution
            let pids = [];
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
            }
            else {
                // Unix: use ps and grep with array-based arguments for better security
                // Using spawn directly with careful arguments
                const ps = spawn('ps', ['aux']);
                let psOutput = '';
                ps.stdout.on('data', (data) => {
                    psOutput += data.toString();
                });
                await new Promise((resolve) => {
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
            this.logger?.info?.('Found existing venv processes', { count: pids.length });
            // Kill each process
            for (const pid of pids) {
                try {
                    this.logger?.info?.('Terminating process', { pid });
                    process.kill(Number(pid));
                }
                catch (killError) {
                    this.logger?.warn?.('Failed to terminate process', {
                        pid,
                        error: killError instanceof Error ? killError.message : String(killError)
                    });
                }
            }
            this.logger?.info?.('Terminated existing venv processes', {
                processCount: pids.length
            });
        }
        catch (error) {
            this.logger?.error?.('Error terminating existing venv processes', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    async cleanupTempFiles() {
        try {
            const now = Date.now();
            const files = await fs.readdir(this.tempDir);
            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                const stats = await fs.stat(filePath);
                const age = now - stats.mtimeMs;
                if (age > this.config.temp.maxAgeMs) {
                    await fs.unlink(filePath).catch(err => this.logger?.error?.('Failed to delete temp file', { file, error: err.message }));
                }
            }
        }
        catch (error) {
            this.logger?.error?.('Error during temp file cleanup', { error });
        }
    }
    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        this.logger?.info?.('Comparing versions', {
            v1,
            v2,
            parts1,
            parts2
        });
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const part1 = parts1[i] || 0;
            const part2 = parts2[i] || 0;
            this.logger?.info?.('Comparing parts', {
                index: i,
                part1,
                part2
            });
            if (part1 !== part2) {
                const result = part1 - part2;
                this.logger?.info?.('Version comparison result', { result });
                return result;
            }
        }
        return 0;
    }
    async verifyPythonVersion() {
        try {
            // Get the default virtual environment's Python executable
            const { pythonExecutable } = this.venvManager.getActivationDetails();
            // Ensure the virtual environment exists before proceeding
            await this.venvManager.setupVirtualEnvironment();
            // Use spawn with array arguments for better security
            const python = spawn(pythonExecutable, ['--version']);
            let stdout = '';
            python.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            // Python might output version to stderr on older versions
            python.stderr.on('data', (data) => {
                stdout += data.toString();
            });
            await new Promise((resolve, reject) => {
                python.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    }
                    else {
                        reject(new Error(`Python process exited with code ${code}`));
                    }
                });
                python.on('error', (err) => {
                    reject(err);
                });
            });
            this.logger?.info?.('Python version output', { stdout });
            const versionMatch = stdout.match(/Python (\d+\.\d+\.\d+)/);
            if (!versionMatch) {
                throw new Error('Could not determine Python version');
            }
            const installedVersion = versionMatch[1];
            const minVersion = this.config.python.minVersion;
            this.logger?.info?.('Version check', {
                installedVersion,
                minVersion,
                config: this.config.python
            });
            const comparison = this.compareVersions(installedVersion, minVersion);
            this.logger?.info?.('Version comparison', { comparison });
            if (comparison < 0) {
                throw new Error(`Python version ${installedVersion} is below required minimum ${minVersion}`);
            }
            this.logger?.info?.('Python version verified', { installed: installedVersion, minimum: minVersion });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Failed to verify Python version', { error: errorMessage });
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
    getVenvPath(venvName) {
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
    getActivationPrefix(venvName) {
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
    async checkVenvExists(venvName) {
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
    async testVirtualEnvironment() {
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
                }
                else {
                    // On Unix, we can directly use the Python executable path
                    const python = spawn(pythonExecutable, [tempScript], {
                        timeout: this.config.execution.timeoutMs,
                        env: { ...process.env }
                    });
                    // Collect stdout and stderr
                    python.stdout.on('data', (data) => {
                        stdout += data.toString();
                    });
                    python.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                    // Wait for completion
                    await new Promise((resolve, reject) => {
                        python.on('close', (code) => {
                            if (code === 0) {
                                resolve();
                            }
                            else {
                                reject(new Error(`Python process exited with code ${code}`));
                            }
                        });
                        python.on('error', (err) => {
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
            }
            finally {
                // Clean up the temporary script regardless of whether the execution succeeded
                await fs.unlink(tempScript).catch((err) => {
                    this.logger?.warn?.('Failed to delete temporary test script', {
                        path: tempScript,
                        error: err instanceof Error ? err.message : String(err)
                    });
                });
            }
        }
        catch (error) {
            process.stderr.write(`VENV TEST ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
    /**
     * Initialize the server and start handling requests
     */
    async run() {
        try {
            console.error("STARTUP: Calling server.run() - begin async setup");
            // Load configuration (awaiting the promise)
            this.config = await loadConfig();
            console.error("STARTUP: Configuration loaded");
            // Initialize logger now that config is loaded
            this.logger = new Logger(this.config.logging || { level: 'info' });
            this.logger.info("STARTUP: Created logger");
            // Initialize venv manager now that config and logger are loaded
            this.venvManager = new VenvManager(this.config, this.logger);
            this.logger.info("STARTUP: Initialized VenvManager");
            // Make sure the default venv exists
            await this.venvManager.setupVirtualEnvironment();
            this.logger.info("STARTUP: Default virtual environment setup complete");
            // Create temp directory for script files
            this.tempDir = path.join(os.tmpdir(), 'python-executor');
            this.logger.info(`Setting temp directory to ${this.tempDir}`);
            await fs.mkdir(this.tempDir, { recursive: true }).catch((err) => this.logger.error(`Failed to create temp directory: ${err.message}`));
            this.logger.info("STARTUP: Temp directory setup complete");
            // Set up cleanup interval after config is loaded
            this.cleanupInterval = setInterval(() => this.cleanupTempFiles(), this.config.temp?.cleanupIntervalMs || 3600000);
            this.logger.info("STARTUP: Set up cleanup interval");
            // Initialize preinstalled packages after venvManager is ready
            await this.initializePreinstalledPackages();
            this.logger.info("STARTUP: Initializing preinstalled packages complete");
            // Create transport and connect server
            const transport = new StdioServerTransport();
            this.server.connect(transport);
            this.logger.info("Server started successfully");
            // Test the virtual environment after everything is set up
            this.testVirtualEnvironment().catch(err => {
                this.logger.error(`Failed to test virtual environment: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        catch (error) {
            // Logger might not be available here, use console.error and then try logger
            console.error(`CRITICAL STARTUP ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`);
            console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
            // Also try to use logger if available
            this.logger?.error?.(`CRITICAL STARTUP ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`, {
                stack: error instanceof Error ? error.stack : 'No stack available'
            });
            process.exit(1); // Exit after logging runtime error
        }
    }
    // Updated method stubs with proper return types
    async handleListPackages(args) {
        try {
            const venvName = args?.venvName;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Verify the environment exists
            const venvExists = await this.venvManager.checkVenvExists(targetVenvName);
            if (!venvExists) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, `Virtual environment does not exist: ${targetVenvName}`);
            }
            // Log which virtual environment is being used
            this.logger?.info?.('Listing packages', { venvName: targetVenvName });
            // Get the packages using the modified getInstalledPackages method
            const packages = await this.getInstalledPackages(targetVenvName);
            // Return packages in a structured format
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            packages,
                            venvName: targetVenvName
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Error listing packages', {
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
    async handleUninstallPackages(args) {
        try {
            if (!isValidInstallArgs(args)) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Missing or invalid packages parameter. Please provide a comma-separated string or array of package names.');
            }
            // Extract venvName from args
            const venvName = args.venvName;
            const targetVenvName = venvName || this.config.python.defaultVenvName;
            // Verify the environment exists
            const venvExists = await this.venvManager.checkVenvExists(targetVenvName);
            if (!venvExists) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, `Virtual environment does not exist: ${targetVenvName}`);
            }
            // Convert packages to array if it's a string
            let packagesArray = [];
            if (typeof args.packages === 'string') {
                packagesArray = args.packages.split(/,\s*/).filter(Boolean);
            }
            else if (Array.isArray(args.packages)) {
                packagesArray = args.packages.filter(pkg => typeof pkg === 'string' && pkg.trim() !== '');
            }
            if (packagesArray.length === 0) {
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'No valid packages specified for uninstallation.');
            }
            // Log which virtual environment is being used
            this.logger?.info?.('Uninstalling packages', { venvName: targetVenvName, packages: packagesArray });
            // Get activation details
            const { activateCmd, isWindows, pythonExecutable } = this.venvManager.getActivationDetails(targetVenvName);
            // Get current installed packages to verify uninstallation later
            const installedPackagesBefore = await this.getInstalledPackages(targetVenvName);
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
                const { stdout: procStdout, stderr: procStderr } = await execAsync(command, execOptions);
                stdout = procStdout;
                stderr = procStderr;
            }
            else {
                // On Unix, we can use spawn directly with the Python executable
                const uninstallProcess = spawn(pythonExecutable, ['-m', 'pip', 'uninstall', '-y', ...packagesArray], {
                    timeout: this.config.execution.packageTimeoutMs,
                    env: { ...process.env }
                });
                // Collect stdout and stderr
                uninstallProcess.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                uninstallProcess.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                // Wait for completion
                await new Promise((resolve, reject) => {
                    uninstallProcess.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        }
                        else {
                            reject(new Error(`Package uninstallation failed with code ${code}: ${stderr}`));
                        }
                    });
                    uninstallProcess.on('error', (err) => {
                        reject(err);
                    });
                });
            }
            // Get installed packages after uninstallation to verify
            const installedPackagesAfter = await this.getInstalledPackages(targetVenvName);
            // Check which packages were successfully uninstalled
            const successfulUninstalls = [];
            const failedUninstalls = [];
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
                    this.logger?.info?.(`Package was not installed, skipping: ${pkg}`);
                }
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: failedUninstalls.length > 0 ? 'partial' : 'success',
                            message: `${successfulUninstalls.length} package(s) uninstalled successfully${failedUninstalls.length > 0 ? `, ${failedUninstalls.length} failed` : ''}`,
                            venvName: targetVenvName,
                            uninstalledPackages: successfulUninstalls,
                            failedPackages: failedUninstalls,
                            stdout: stdout.substring(0, 1000), // Limit output size
                            stderr: stderr.substring(0, 1000) // Limit output size
                        }, null, 2),
                        mediaType: 'application/json'
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Package uninstallation error', {
                error: errorMessage,
                venvName: args?.venvName
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'error',
                            message: `Error uninstalling packages: ${errorMessage}`,
                            venvName: args?.venvName || this.config.python.defaultVenvName
                        }, null, 2),
                        mediaType: 'application/json'
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
    const server = new PythonExecutorServer(); // Basic server object created
    console.error("STARTUP: Calling server.run()"); // Log before calling async run
    server.run().catch((error) => {
        // Logger should be available here after run()
        console.error(`CRITICAL STARTUP ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`);
        console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
        // Also try to use logger if available
        server.logger?.error?.(`CRITICAL STARTUP ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`, {
            stack: error instanceof Error ? error.stack : 'No stack available'
        });
        process.exit(1); // Exit after logging runtime error
    });
}
catch (error) {
    console.error(`CRITICAL STARTUP ERROR IN RUN: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
    process.exit(1); // Exit after logging runtime error
}
