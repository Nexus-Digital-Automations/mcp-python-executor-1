#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode as McpErrorCode, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
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
        (typeof args.code === 'string' || typeof args.scriptPath === 'string') &&
        (args.inputData === undefined ||
            (Array.isArray(args.inputData) &&
                args.inputData.every((item) => typeof item === 'string'))));
};
const isValidInstallArgs = (args) => {
    return (typeof args === 'object' &&
        args !== null &&
        (typeof args.packages === 'string' ||
            (Array.isArray(args.packages) &&
                args.packages.every((pkg) => typeof pkg === 'string'))));
};
class PythonExecutorServer {
    constructor() {
        this.config = loadConfig();
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
            }
        };
        this.server = new Server({
            name: 'mcp-python-executor',
            version: '0.2.0'
        }, {
            capabilities: {
                prompts: {},
                tools: {}
            }
        });
        this.venvDir = this.config.python.venvPath;
        this.cleanupInterval = setInterval(() => this.cleanupTempFiles(), this.config.temp.cleanupIntervalMs);
        this.logger = new Logger(this.config.logging);
        this.setupPromptHandlers();
        // Create temp directory for script files
        this.tempDir = path.join(os.tmpdir(), 'python-executor');
        fs.mkdir(this.tempDir, { recursive: true }).catch((err) => this.logger.error('Failed to create temp directory', { error: err.message }));
        // Enable code analysis features
        this.config.python.analysis.enableSecurity = true;
        this.config.python.analysis.enableStyle = true;
        this.config.python.analysis.enableComplexity = true;
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
    setupToolHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'execute_python',
                    description: `Execute Python code in a secure, isolated environment with configurable resource limits.

Features:
- Automatic virtual environment management
- Resource monitoring (memory, CPU)
- Input/output stream handling
- Error handling and timeout protection
- Support for both inline code and existing script files

Example workflow:
1. First install required packages using install_packages
2. Write your Python code with proper error handling
3. Optionally prepare input data as string array
4. Call execute_python with your code or scriptPath
5. Check the response for output or errors
6. For long-running scripts, monitor health_check

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
   - Install numpy and pandas
   - Load and process data
   - Output results

2. Machine learning:
   - Install scikit-learn
   - Train model
   - Make predictions

3. Web scraping:
   - Install requests and beautifulsoup4
   - Fetch and parse content
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
                            },
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

Example workflow:
1. Check health_check to verify Python environment
2. Prepare list of required packages with versions
3. Call install_packages with package list
4. Verify installation in health_check
5. Use packages in execute_python

Example usage:
{
  "packages": "numpy>=1.20.0, pandas, matplotlib"
}

or with array format:
{
  "packages": ["numpy>=1.20.0", "pandas", "matplotlib"]
}

Common workflows:
1. New project setup:
   - Install base requirements
   - Verify versions
   - Test imports

2. Adding dependencies:
   - Check existing packages
   - Install new packages
   - Resolve conflicts

3. Environment replication:
   - Export requirements
   - Install on new system
   - Verify setup`,
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
                            },
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
                    return this.handleHealthCheck();
                case 'analyze_code':
                    return this.handleAnalyzeCode(request.params.arguments);
                default:
                    throw new McpError(McpErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async getInstalledPackages() {
        try {
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
            this.logger.info('Created package listing script', { scriptPath });
            // Determine activation command based on OS
            const isWindows = os.platform() === 'win32';
            let activateCmd = '';
            let command = '';
            if (this.config.python.useVirtualEnv) {
                // Construct activation command based on platform
                if (isWindows) {
                    // Windows activation
                    activateCmd = `${this.venvDir}\\Scripts\\activate.bat`;
                    command = `${activateCmd} && python "${scriptPath}"`;
                }
                else {
                    // Unix-based activation (Linux/macOS)
                    activateCmd = `source ${this.venvDir}/bin/activate`;
                    command = `${activateCmd} && python "${scriptPath}"`;
                }
            }
            else {
                command = `python "${scriptPath}"`;
            }
            this.logger.info('Getting installed packages with command', { command });
            // For Windows, we need to use cmd.exe to properly handle the activation
            const execOptions = {
                timeout: this.config.execution.packageTimeoutMs,
                env: { ...process.env },
                ...(isWindows && this.config.python.useVirtualEnv ? { shell: 'cmd.exe' } : {})
            };
            const { stdout, stderr } = await execAsync(command, execOptions);
            // Clean up temporary file
            await fs.unlink(scriptPath).catch(err => this.logger.error('Failed to clean up package listing script', { error: err.message }));
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
            }
            catch (parseError) {
                this.logger.error('Failed to parse package list output', {
                    error: parseError instanceof Error ? parseError.message : String(parseError),
                    stdout
                });
                return {};
            }
        }
        catch (error) {
            this.logger.error('Failed to get installed packages', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            return {}; // Return empty object in case of error
        }
    }
    async handleHealthCheck() {
        const pythonVersion = await this.getPythonVersion();
        const stats = metrics.getStats();
        const installedPackages = await this.getInstalledPackages();
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
                        installedPackages,
                    }, null, 2),
                    mediaType: 'application/json'
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
            // Determine the script path - either from args.scriptPath or by creating a temp file for code
            let scriptPath;
            let isTemporaryScript = false;
            if (args.scriptPath) {
                // Use provided script path
                scriptPath = args.scriptPath;
                // Verify the script exists
                try {
                    await fs.access(scriptPath);
                }
                catch (error) {
                    throw new ExecutorError(ErrorCode.INVALID_INPUT, `Script file not found: ${scriptPath}`);
                }
            }
            else if (args.code) {
                // Create temporary script file from code string
                scriptPath = path.join(this.tempDir, `script_${Date.now()}.py`);
                await fs.writeFile(scriptPath, args.code);
                isTemporaryScript = true;
            }
            else {
                // This should never happen due to isValidExecuteArgs check
                throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Either code or scriptPath must be provided');
            }
            let results;
            const isWindows = os.platform() === 'win32';
            if (this.config.python.useVirtualEnv) {
                // Use the virtual environment via command line for consistency with other methods
                let command;
                if (isWindows) {
                    // Windows activation
                    const activateCmd = `${this.venvDir}\\Scripts\\activate.bat`;
                    command = `${activateCmd} && python "${scriptPath}"`;
                }
                else {
                    // Unix-based activation (Linux/macOS)
                    const activateCmd = `source ${this.venvDir}/bin/activate`;
                    command = `${activateCmd} && python "${scriptPath}"`;
                }
                if (args.inputData && args.inputData.length > 0) {
                    this.logger.info('Input data provided, will use python-shell instead', {
                        inputDataLength: args.inputData.length
                    });
                    // When input data is provided, use PythonShell for stdin
                    const options = {
                        mode: 'text',
                        pythonPath: this.config.python.useVirtualEnv && isWindows
                            ? path.join(this.venvDir, 'Scripts', 'python.exe')
                            : this.config.python.useVirtualEnv
                                ? path.join(this.venvDir, 'bin', 'python')
                                : 'python',
                        pythonOptions: ['-u'],
                        scriptPath: path.dirname(scriptPath),
                        args: args.inputData || [],
                    };
                    // Execute with timeout
                    results = await Promise.race([
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
                }
                else {
                    // For scripts without input data, use the command line approach which is more reliable
                    // for accessing the virtual environment
                    this.logger.info('Executing Python script with command', { command });
                    // For Windows, we need to use cmd.exe to properly handle the activation
                    const execOptions = {
                        timeout: this.config.execution.timeoutMs,
                        env: { ...process.env },
                        ...(isWindows && this.config.python.useVirtualEnv ? { shell: 'cmd.exe' } : {})
                    };
                    const { stdout, stderr } = await execAsync(command, execOptions);
                    if (stderr) {
                        this.logger.info('Stderr during Python execution', { stderr });
                    }
                    results = stdout.split('\n');
                }
            }
            else {
                // Not using virtual environment, use the standard PythonShell approach
                const options = {
                    mode: 'text',
                    pythonPath: 'python',
                    pythonOptions: ['-u'],
                    scriptPath: path.dirname(scriptPath),
                    args: args.inputData || [],
                };
                // Execute with timeout
                results = await Promise.race([
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
            }
            // Clean up temporary file if we created one
            if (isTemporaryScript) {
                await fs.unlink(scriptPath).catch((err) => this.logger.error('Failed to clean up temp file', { error: err.message }));
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
        }
        finally {
            this.activeExecutions--;
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
                    await fs.unlink(filePath).catch(err => this.logger.error('Failed to delete temp file', { file, error: err.message }));
                }
            }
        }
        catch (error) {
            this.logger.error('Error during temp file cleanup', { error });
        }
    }
    compareVersions(v1, v2) {
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
    async verifyPythonVersion() {
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
    async setupVirtualEnvironment() {
        if (!this.config.python.useVirtualEnv)
            return;
        try {
            // Check if virtual environment already exists
            const venvExists = await fs.access(this.venvDir)
                .then(() => true)
                .catch(() => false);
            if (!venvExists) {
                await execAsync(`python -m venv ${this.venvDir}`);
                this.logger.info('Created virtual environment', { path: this.venvDir });
            }
        }
        catch (error) {
            this.logger.error('Failed to setup virtual environment', { error });
            throw error;
        }
    }
    async handleInstallPackages(args) {
        if (!isValidInstallArgs(args)) {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Invalid package installation arguments');
        }
        try {
            // Verify Python version
            await this.verifyPythonVersion();
            // Setup virtual environment if enabled
            await this.setupVirtualEnvironment();
            // Install UV if not already installed
            try {
                await execAsync('uv --version');
            }
            catch {
                this.logger.info('Installing UV package installer');
                await execAsync('curl -LsSf https://astral.sh/uv/install.sh | sh');
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
            // Determine activation command based on OS
            const isWindows = os.platform() === 'win32';
            let activateCmd = '';
            let command = '';
            let fallbackCommand = '';
            if (this.config.python.useVirtualEnv) {
                // Construct activation command based on platform
                if (isWindows) {
                    // Windows activation
                    activateCmd = `${this.venvDir}\\Scripts\\activate.bat`;
                    command = `${activateCmd} && uv pip install ${packages}`;
                    // Fallback command with --no-binary for problematic packages
                    if (packagesWithPotentialWheelIssues.length > 0) {
                        const noBinaryFlags = packagesWithPotentialWheelIssues
                            .map(pkg => pkg.split(/[=<>~!]/)[0].trim())
                            .map(pkg => `--no-binary=${pkg}`)
                            .join(' ');
                        fallbackCommand = `${activateCmd} && uv pip install ${noBinaryFlags} ${packages}`;
                    }
                }
                else {
                    // Unix-based activation (Linux/macOS)
                    activateCmd = `source ${this.venvDir}/bin/activate`;
                    command = `${activateCmd} && uv pip install ${packages}`;
                    // Fallback command with --no-binary for problematic packages
                    if (packagesWithPotentialWheelIssues.length > 0) {
                        const noBinaryFlags = packagesWithPotentialWheelIssues
                            .map(pkg => pkg.split(/[=<>~!]/)[0].trim())
                            .map(pkg => `--no-binary=${pkg}`)
                            .join(' ');
                        fallbackCommand = `${activateCmd} && uv pip install ${noBinaryFlags} ${packages}`;
                    }
                }
            }
            else {
                command = `uv pip install ${packages}`;
                // Fallback command with --no-binary for problematic packages
                if (packagesWithPotentialWheelIssues.length > 0) {
                    const noBinaryFlags = packagesWithPotentialWheelIssues
                        .map(pkg => pkg.split(/[=<>~!]/)[0].trim())
                        .map(pkg => `--no-binary=${pkg}`)
                        .join(' ');
                    fallbackCommand = `uv pip install ${noBinaryFlags} ${packages}`;
                }
            }
            this.logger.info('Installing packages with command', { command });
            // For Windows, we need to use cmd.exe to properly handle the activation
            const execOptions = {
                timeout: this.config.execution.packageTimeoutMs,
                env: { ...process.env },
                ...(isWindows && this.config.python.useVirtualEnv ? { shell: 'cmd.exe' } : {})
            };
            let stdout = '';
            let stderr = '';
            let wheelBuildIssueDetected = false;
            try {
                const result = await execAsync(command, execOptions);
                stdout = result.stdout;
                stderr = result.stderr;
            }
            catch (installError) {
                // Check if the error is related to wheel building
                const errorMessage = installError instanceof Error ? installError.message : String(installError);
                const stdoutStr = installError instanceof Error && 'stdout' in installError
                    ? String(installError.stdout)
                    : '';
                const stderrStr = installError instanceof Error && 'stderr' in installError
                    ? String(installError.stderr)
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
                wheelBuildIssueDetected = wheelBuildErrorPatterns.some(pattern => pattern.test(combinedOutput));
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
                    }
                    catch (fallbackError) {
                        // If fallback also fails, try installing packages one by one
                        this.logger.error('Fallback installation failed, trying packages individually', {
                            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                        });
                        // Collect outputs from individual installations
                        const individualResults = [];
                        for (const pkg of packagesArray) {
                            try {
                                const pkgName = pkg.split(/[=<>~!]/)[0].trim();
                                const isProblematic = packagesWithPotentialWheelIssues.some(p => p.split(/[=<>~!]/)[0].trim() === pkgName);
                                let individualCommand = '';
                                if (this.config.python.useVirtualEnv) {
                                    if (isWindows) {
                                        individualCommand = `${activateCmd} && uv pip install ${isProblematic ? '--no-binary=' + pkgName : ''} "${pkg.replace(/"/g, '\\"')}"`;
                                    }
                                    else {
                                        individualCommand = `${activateCmd} && uv pip install ${isProblematic ? '--no-binary=' + pkgName : ''} "${pkg.replace(/"/g, '\\"')}"`;
                                    }
                                }
                                else {
                                    individualCommand = `uv pip install ${isProblematic ? '--no-binary=' + pkgName : ''} "${pkg.replace(/"/g, '\\"')}"`;
                                }
                                this.logger.info(`Installing package individually: ${pkg}`, { command: individualCommand });
                                const result = await execAsync(individualCommand, execOptions);
                                individualResults.push({
                                    package: pkg,
                                    success: true,
                                    output: result.stdout + (result.stderr ? `\nWarnings/Errors:\n${result.stderr}` : '')
                                });
                            }
                            catch (individualError) {
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
                }
                else {
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
            const missingPackages = [];
            const installedDetails = [];
            for (const pkg of requestedPackages) {
                const isInstalled = installedNames.includes(pkg);
                if (!isInstalled) {
                    // Try to find similar package names that might have been installed
                    const similarPackages = installedNames.filter(name => name.includes(pkg) || pkg.includes(name)).slice(0, 5);
                    missingPackages.push(pkg);
                    this.logger.error(`Package "${pkg}" not found after installation`, {
                        similarPackagesFound: similarPackages
                    });
                }
                else {
                    const version = installedPackages[pkg] ||
                        installedPackages[Object.keys(installedPackages).find(name => name.toLowerCase() === pkg.toLowerCase()) || 'unknown'];
                    installedDetails.push(`${pkg}: ${version}`);
                }
            }
            if (missingPackages.length > 0) {
                this.logger.error('Some packages were not found after installation', {
                    missing: missingPackages,
                    installed: installedDetails
                });
            }
            else {
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
                                    pkg.match(/^([^=<>~!]+)/)[1].trim().toLowerCase() :
                                    pkg.toLowerCase();
                                return !missingPackages.includes(normalizedName);
                            }),
                            environment: this.config.python.useVirtualEnv ? 'virtual environment' : 'system Python',
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
        }
        catch (error) {
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
    async handleAnalyzeCode(args) {
        if (!args?.code || typeof args.code !== 'string') {
            throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Invalid code analysis arguments');
        }
        try {
            const results = {
                security: null,
                style: null,
                complexity: null,
            };
            // Create temporary file for analysis
            const scriptPath = path.join(this.tempDir, `analysis_${Date.now()}.py`);
            await fs.writeFile(scriptPath, args.code);
            try {
                const isWindows = os.platform() === 'win32';
                let activatePrefix = '';
                // Determine activation command based on OS
                if (this.config.python.useVirtualEnv) {
                    if (isWindows) {
                        // Windows activation
                        activatePrefix = `${this.venvDir}\\Scripts\\activate.bat && `;
                    }
                    else {
                        // Unix-based activation
                        activatePrefix = `source ${this.venvDir}/bin/activate && `;
                    }
                }
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
                const command = `${activatePrefix}python "${analysisScriptPath}"`;
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
                }
                catch (parseError) {
                    this.logger.error('Error parsing analysis results', {
                        error: parseError instanceof Error ? parseError.message : String(parseError),
                        stdout
                    });
                }
                // Clean up analysis script
                await fs.unlink(analysisScriptPath).catch(err => this.logger.error('Failed to clean up analysis script', { error: err.message }));
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
            }
            finally {
                // Clean up the code file
                await fs.unlink(scriptPath).catch(err => this.logger.error('Failed to clean up analysis source file', { error: err.message }));
            }
        }
        catch (error) {
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
    generateAnalysisSummary(results) {
        let summary = 'Code Analysis Summary:\n\n';
        // Helper function to escape Unicode characters
        const ensureAscii = (str) => {
            return str.replace(/[^\x00-\x7F]/g, '');
        };
        if (results.security) {
            const issues = results.security.results || [];
            summary += `Security: ${issues.length} issue(s) found\n`;
            if (issues.length > 0) {
                summary += 'Top issues:\n';
                issues.slice(0, 3).forEach((issue, index) => {
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
                issues.slice(0, 3).forEach((issue, index) => {
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
                functions.forEach((func) => {
                    totalComplexity += func.complexity || 0;
                });
            });
            const avgComplexity = functionCount > 0 ? (totalComplexity / functionCount).toFixed(1) : 0;
            summary += `Complexity: ${functionCount} function(s) analyzed with average complexity of ${avgComplexity}\n`;
            if (functionCount > 0) {
                summary += 'Most complex functions:\n';
                let allFunctions = [];
                files.forEach(file => {
                    const functions = results.complexity[file] || [];
                    allFunctions = allFunctions.concat(functions);
                });
                allFunctions.sort((a, b) => (b.complexity || 0) - (a.complexity || 0));
                allFunctions.slice(0, 3).forEach((func, index) => {
                    summary += `  ${index + 1}. ${ensureAscii(func.name || 'Unknown')} (Complexity: ${func.complexity || 'unknown'})\n`;
                });
            }
        }
        return summary;
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
