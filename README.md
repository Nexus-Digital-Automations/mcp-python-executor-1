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
  code: string;          // Python code to execute
  inputData?: string[];  // Optional input data
}
```

Example:

```javascript
{
  "code": "print('Hello, World!!')\nfor i in range(3): print(i)",
  "inputData": ["optional", "input", "data"]
}
```

### 2. install_packages

Install Python packages using pip.

```typescript
interface InstallPackageArgs {
  packages: string[];  // Array of package names to install
}
```

Example:

```javascript
{
  "packages": ["requests", "beautifulsoup4"]
}
```

### 3. health_check

Check server health status and get metrics.

Returns:

```javascript
{
  "status": "healthy",
  "version": "0.1.0",
  "pythonVersion": "Python 3.11.0",
  "config": {
    // Current server configuration
  },
  "metrics": {
    "totalExecutions": 100,
    "totalErrors": 2,
    "successRate": 98,
    "averageExecutionTimeMs": 150,
    "averageMemoryUsageMb": 45,
    // ...more metrics
  }
}
```

## Safety Features

1. Resource Constraints
   - Memory usage limits
   - Execution timeouts
   - Concurrent execution limits

2. Error Handling
   - Structured error messages
   - Error categorization
   - Detailed error context

3. Monitoring
   - Execution metrics
   - Memory usage tracking
   - Success/failure rates
   - Performance statistics

## Development

### Building

```bash
npm install
npm run build
```

### Testing

```bash
npm test
```

## Error Codes

- `EXECUTION_TIMEOUT`: Script execution exceeded time limit
- `MEMORY_LIMIT_EXCEEDED`: Script exceeded memory limit
- `PYTHON_ERROR`: Python runtime or syntax error
- `INVALID_INPUT`: Invalid tool arguments
- `PACKAGE_INSTALLATION_ERROR`: Failed to install packages
- `INTERNAL_ERROR`: Server internal error

## Logging

Logs are structured and can be formatted as JSON or text. Each log entry includes:

- Timestamp
- Log level
- Message
- Context (optional)

Example JSON log:

```json
{
  "level": "info",
  "message": "Executing Python script",
  "timestamp": "2024-03-18T12:34:56.789Z",
  "context": {
    "scriptSize": 1024,
    "timeout": 30000
  }
}
