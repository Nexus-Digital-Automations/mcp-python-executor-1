# MCP Python Executor

A Model Context Protocol (MCP) server for executing Python code and managing Python packages.

## Features

- Execute Python code with safety constraints
- Install and manage Python packages
- Pre-configure commonly used packages
- Resource monitoring and limits
- Health checks and metrics
- Structured logging

## Configuration

The server can be configured through environment variables in the MCP settings:

```json
{
  "mcpServers": {
    "mcp-python-executor": {
      "command": "node",
      "args": ["path/to/python-executor/build/index.js"],
      "env": {
        "PREINSTALLED_PACKAGES": "numpy pandas matplotlib scikit-learn",
        "MAX_MEMORY_MB": "512",
        "EXECUTION_TIMEOUT_MS": "30000",
        "MAX_CONCURRENT_EXECUTIONS": "5",
        "LOG_LEVEL": "info",
        "LOG_FORMAT": "json"
      }
    }
  }
}
```

### Environment Variables

- `PREINSTALLED_PACKAGES`: Space-separated list of Python packages to install on startup
- `MAX_MEMORY_MB`: Maximum memory limit per execution (default: 512)
- `EXECUTION_TIMEOUT_MS`: Maximum execution time in milliseconds (default: 30000)
- `MAX_CONCURRENT_EXECUTIONS`: Maximum number of concurrent executions (default: 5)
- `LOG_LEVEL`: Logging level (debug|info|error, default: info)
- `LOG_FORMAT`: Log format (json|text, default: json)

## Available Tools

### 1. execute_python

Execute Python code and return the results.

```typescript
interface ExecutePythonArgs {
  code?: string;          // Python code to execute (inline)
  scriptPath?: string;    // Path to existing Python script file (alternative to code)
  inputData?: string[];   // Optional input data
}
```

Examples:

```javascript
// Example with inline code
{
  "code": "print('Hello, World!!')\nfor i in range(3): print(i)",
  "inputData": ["optional", "input", "data"]
}

// Example with script path
{
  "scriptPath": "/path/to/your_script.py",
  "inputData": ["optional", "input", "data"]
}
```

### 2. install_packages

Install Python packages.

```typescript
interface InstallPackagesArgs {
  packages: string[];
}
```

Example:

```
