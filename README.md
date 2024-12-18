# MCP Python Executor Server

A Model Context Protocol (MCP) server that enables secure Python code execution and package management within the Claude environment. This server allows Claude to execute Python code snippets and manage Python packages dynamically.

## Features

### Python Code Execution
- Execute arbitrary Python code snippets
- Support for input data streams
- Secure execution in isolated environment
- Unbuffered output for real-time feedback
- Automatic cleanup of temporary script files

### Package Management
- Dynamic Python package installation via pip
- Support for pre-configured package installation
- Batch package installation capabilities
- Error handling and feedback for failed installations

## Tools

### `execute_python`
Executes Python code and returns the results.

Parameters:
- `code` (string, required): Python code to execute
- `inputData` (string[], optional): Array of input strings for the script

Example:
```json
{
  "name": "execute_python",
  "arguments": {
    "code": "print('Hello, World!')",
    "inputData": ["optional", "input", "data"]
  }
}
```

### `install_packages`
Installs Python packages using pip.

Parameters:
- `packages` (string[], required): Array of package names to install

Example:
```json
{
  "name": "install_packages",
  "arguments": {
    "packages": ["numpy", "pandas", "matplotlib"]
  }
}
```

## Environment Setup

### Prerequisites
- Node.js (v14 or higher)
- Python (v3.6 or higher)
- pip package manager

### Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd python-executor
```

2. Install dependencies:
```bash
npm install
```

3. Build the server:
```bash
npm run build
```

### Configuration

#### Pre-installed Packages
You can configure packages to be installed automatically when the server starts by setting the `PREINSTALLED_PACKAGES` environment variable:

```bash
export PREINSTALLED_PACKAGES="numpy pandas matplotlib"
```

#### Claude Desktop Integration

Add the server configuration to your Claude Desktop config file:

Windows:
```json
// %APPDATA%/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "mcp-python-executor": {
      "command": "C:/path/to/python-executor/build/index.js",
      "env": {
        "PREINSTALLED_PACKAGES": "numpy pandas matplotlib"
      }
    }
  }
}
```

MacOS:
```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "mcp-python-executor": {
      "command": "/path/to/python-executor/build/index.js",
      "env": {
        "PREINSTALLED_PACKAGES": "numpy pandas matplotlib"
      }
    }
  }
}
```

## Development

### Running in Development Mode

For development with auto-rebuild:
```bash
npm run watch
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. Use the built-in MCP Inspector:

```bash
npm run inspector
```

The Inspector provides a web interface for:
- Monitoring server input/output
- Testing tool execution
- Inspecting server state
- Debugging errors

### Error Handling

The server implements comprehensive error handling:
- Invalid argument validation
- Python execution errors
- Package installation failures
- Server initialization errors

All errors are properly logged and returned with appropriate MCP error codes.

## Architecture

The server is built using TypeScript and implements the Model Context Protocol. Key components:

- `PythonExecutorServer`: Main server class handling MCP communication
- `StdioServerTransport`: Manages stdio-based communication
- Temporary file management for script execution
- Environment configuration and initialization
- Tool registration and request handling

## Security Considerations

- Scripts are executed in isolated temporary files
- Automatic cleanup of temporary files
- Input validation for all arguments
- Package installation restricted to pip
- Error isolation and proper handling

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

[Specify License]

## Support

For issues and feature requests, please use the GitHub issue tracker.