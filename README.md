# MCP Python Executor

A Model Context Protocol (MCP) server for executing Python code and managing Python packages. Now with multi-environment support!

## Features

- Execute Python code with safety constraints
- Install and manage Python packages
- Pre-configure commonly used packages
- Multiple virtual environment support
- Resource monitoring and limits
- Health checks and metrics
- Structured logging
- Secure command execution
- Robust asynchronous initialization

## Package Management

The MCP Python Executor provides a clean environment approach where no packages are preinstalled by default. This gives you complete control over your Python environments:

- **Clean Start**: Each virtual environment starts with only Python standard library modules
- **On-Demand Installation**: Install only the packages you need when you need them
- **Environment Isolation**: Keep different package sets in separate virtual environments
- **Version Control**: Explicitly specify package versions for reproducible environments
- **Custom Configurations**: Create purpose-specific environments (e.g., data science, web development)

To install packages, use the `install_packages` tool before running your Python code. This approach aligns with Python's "explicit is better than implicit" philosophy and helps avoid package conflicts.

```javascript
// Example workflow
// 1. First, install required packages
{
  "packages": ["numpy", "pandas", "matplotlib"],
  "venvName": "data-science"
}

// 2. Then, execute your Python code
{
  "code": "import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\n\n# Your code here",
  "venvName": "data-science"
}
```

## Virtual Environment Support

All tools in the MCP Python Executor support an optional `venvName` parameter to specify which virtual environment to use. If no environment is specified, the server uses the configured default environment.

Key virtual environment features:
- Secure name validation to prevent path traversal attacks
- Isolation between environments for packages and dependencies
- Concurrent operations on different environments
- Detailed metadata for each environment
- Command execution within the context of specific environments
- Consistent fallback to default environment
- Smart handling of Python version specification

When creating virtual environments with specific Python versions, you can use either:
- A full command or path (e.g., "python3", "/usr/bin/python3.9")
- Just the version number (e.g., "3.12") which is automatically converted to the corresponding executable name (e.g., "python3.12")

## File Output Operations

When your Python code needs to save files (such as plots, data exports, or generated content), you must follow a specific pattern to ensure the files are saved to a writable location:

1. **Use the OUTPUT_PATH Environment Variable**: The Executor uses an environment variable named `OUTPUT_PATH` to specify where files should be saved.

2. **Include Output Directory Handling**: Add the following code at the beginning of your script:
   ```python
   import os
   import pathlib

   # Get the output directory from the environment variable 'OUTPUT_PATH'
   # Default to the current working directory '.' if the variable is not set.
   output_dir = os.environ.get('OUTPUT_PATH', '.')

   # Create the directory if it doesn't exist, including any parent directories.
   # exist_ok=True prevents an error if the directory already exists.
   pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)

   # Optional: Print the output directory for confirmation
   print(f"Using output directory: {output_dir}")
   ```

3. **Use the Directory for All File Operations**: When saving files, always use the `output_dir` variable:
   ```python
   # Example of saving a matplotlib figure
   import matplotlib.pyplot as plt
   plt.figure()
   plt.plot([1, 2, 3, 4])
   plt.title('Simple Plot')
   plt.savefig(os.path.join(output_dir, 'plot.png'))

   # Example of saving data
   import numpy as np
   data = np.random.rand(10, 10)
   np.save(os.path.join(output_dir, 'random_data.npy'), data)
   ```

4. **Client Responsibility**: When making a request to the Executor, the client (the application calling the Executor) must set the `OUTPUT_PATH` environment variable to point to a writable directory path on the host system.

**Note**: Failure to follow this pattern may result in a `Read-only file system` error or files being saved to inaccessible locations.

## Server Initialization

The MCP Python Executor implements a robust two-phase initialization process:

1. **Synchronous Setup Phase**: 
   - Basic server object creation
   - Handler registration
   - Error handler setup

2. **Asynchronous Initialization Phase**:
   - Configuration loading
   - Logger initialization
   - Virtual environment manager setup
   - Default environment creation
   - Directory preparation
   - Server connection establishment

This approach ensures all dependencies are properly initialized in the correct order while providing comprehensive error handling during startup.

## Configuration

The server can be configured through environment variables in the MCP settings:

```json
{
  "mcpServers": {
    "mcp-python-executor": {
      "command": "node",
      "args": ["path/to/python-executor/build/index.js"],
      "env": {
        "MAX_MEMORY_MB": "512",
        "EXECUTION_TIMEOUT_MS": "30000",
        "MAX_CONCURRENT_EXECUTIONS": "10",
        "LOG_LEVEL": "info",
        "LOG_FORMAT": "json",
        "VENVS_BASE_PATH": "/path/to/venvs/directory",
        "DEFAULT_VENV_NAME": "default",
        "OUTPUT_PATH": "/path/to/writable/output/directory"
      }
    }
  }
}
```

### Environment Variables

- `MAX_MEMORY_MB`: Maximum memory limit per execution (default: 512)
- `EXECUTION_TIMEOUT_MS`: Maximum execution time in milliseconds (default: 30000)
- `MAX_CONCURRENT_EXECUTIONS`: Maximum number of concurrent executions (default: 5)
- `LOG_LEVEL`: Logging level (debug|info|error, default: info)
- `LOG_FORMAT`: Log format (json|text, default: json)
- `VENVS_BASE_PATH`: Base directory for storing virtual environments (default: ~/.mcp-python-venvs)
- `DEFAULT_VENV_NAME`: Name of the default virtual environment (default: "default")

## Available Tools

### 1. execute_python

Execute Python code and return the results.

```typescript
interface ExecutePythonArgs {
  code?: string;          // Python code to execute (inline)
  scriptPath?: string;    // Path to existing Python script file (alternative to code)
  inputData?: string[];   // Optional input data
  venvName?: string;      // Optional virtual environment name
}
```

Examples:

```javascript
// Example with inline code using default environment and file output
{
  "code": "import os\nimport pathlib\n\n# Get output directory from environment variable\noutput_dir = os.environ.get('OUTPUT_PATH', '.')\n# Create the directory if needed\npathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)\n\n# Now we can safely save files\nwith open(os.path.join(output_dir, 'hello.txt'), 'w') as f:\n    f.write('Hello, World!!')\n\nfor i in range(3):\n    print(i)",
  "inputData": ["optional", "input", "data"]
}

// Example with script path using specific environment
{
  "scriptPath": "/path/to/your_script.py",
  "inputData": ["optional", "input", "data"],
  "venvName": "data-science-env"
}
```

**Note**: When executing code that saves files, ensure that:
1. Your code includes the output directory handling pattern shown above
2. The OUTPUT_PATH environment variable is set to a writable directory before execution

### 2. execute_python_file

Execute a Python file within a specified virtual environment.

```typescript
interface ExecutePythonFileArgs {
  filePath: string;       // Path to the Python file to execute
  venvName?: string;      // Optional virtual environment name
  inputData?: string[];   // Optional input data
}
```

Features:
- Execute an existing Python script file
- Use a specific virtual environment for execution
- Pass input data to the script via stdin
- Capture stdout and stderr
- Error handling and timeout protection

Example:

```javascript
// Execute a specific Python file using a custom environment
{
  "filePath": "/path/to/your/existing_script.py",
  "venvName": "my-project-env",
  "inputData": ["line1", "line2"]
}

// Execute a Python file in the default environment
{
  "filePath": "/path/to/your/script.py"
}
```

**Note**: When executing code that saves files, ensure that:
1. Your code includes the output directory handling pattern shown in the execute_python example
2. The OUTPUT_PATH environment variable is set to a writable directory before execution

### 3. install_packages

Install Python packages.

```typescript
interface InstallPackagesArgs {
  packages: string[] | string;  // Array of packages or comma-separated string
  venvName?: string;            // Optional virtual environment name
}
```

Example:

```javascript
// Install packages in default environment
{
  "packages": ["numpy", "pandas", "matplotlib"]
}

// Install packages in specific environment
{
  "packages": "tensorflow==2.12.0,keras",
  "venvName": "machine-learning"
}
```

### 4. uninstall_packages

Uninstall Python packages.

```typescript
interface UninstallPackagesArgs {
  packages: string[] | string;  // Array of packages or comma-separated string
  venvName?: string;            // Optional virtual environment name
}
```

Example:

```javascript
// Uninstall packages from default environment
{
  "packages": ["unused-package1", "unused-package2"]
}

// Uninstall packages from specific environment
{
  "packages": "tensorflow,keras",
  "venvName": "machine-learning"
}
```

### 5. list_packages

List installed packages.

```typescript
interface ListPackagesArgs {
  venvName?: string;  // Optional virtual environment name
}
```

Example:

```javascript
// List packages in specific environment
{
  "venvName": "data-science-env"
}

// List packages in default environment
{}
```

### 6. list_venvs

List all available virtual environments.

```typescript
interface ListVenvsArgs {
  // No parameters required
}
```

### 7. create_venv

Create a new virtual environment.

```typescript
interface CreateVenvArgs {
  venvName: string;      // Name for the new virtual environment
  description?: string;  // Optional description
  pythonVersion?: string; // Optional Python version to use (e.g., "3.9", "python3")
}
```

Example:

```javascript
// Create with full Python command specification
{
  "venvName": "machine-learning",
  "description": "Environment for ML projects with TensorFlow",
  "pythonVersion": "python3.9" // Specify Python executable to use
}

// Create with just version number (will be prefixed with "python" automatically)
{
  "venvName": "data-science",
  "description": "Environment for data analysis",
  "pythonVersion": "3.12" // Will be converted to "python3.12" automatically
}
```

When creating a virtual environment:
- The environment will be created with the specified Python version if provided
- Version-only inputs (e.g., "3.12") are automatically converted to executable names (e.g., "python3.12")
- pip will automatically be installed and upgraded to the latest version
- The environment will be isolated from system packages

### 8. delete_venv

Delete a virtual environment.

```typescript
interface DeleteVenvArgs {
  venvName: string;    // Name of the virtual environment to delete
  confirm?: boolean;   // Required to delete the default environment
}
```

Example:

```javascript
{
  "venvName": "obsolete-env"
}
```

### 9. set_venv_description

Update the description for a virtual environment.

```typescript
interface SetVenvDescriptionArgs {
  venvName: string;     // Name of the virtual environment
  description: string;  // New description
}
```

Example:

```javascript
{
  "venvName": "data-science-env",
  "description": "Environment for data science with pandas and scikit-learn"
}
```

### 10. health_check

Check health of the server and virtual environments.

```typescript
interface HealthCheckArgs {
  venvName?: string;  // Optional virtual environment to check specifically
}
```

Example:

```javascript
// Check health of a specific environment
{
  "venvName": "data-science-env"
}

// Check overall server health
{}
```

## Security Considerations

- The server employs strict validation on virtual environment names to prevent path traversal attacks
- Command execution uses array-based arguments with spawn where possible to prevent command injection
- Each virtual environment has its own locking mechanism to prevent race conditions during concurrent operations
- The VenvManager class acts as a secure gateway for all virtual environment operations
- Python version verification uses the environment's Python executable, not the system Python
- The server initialization process ensures all components are properly set up before accepting requests
