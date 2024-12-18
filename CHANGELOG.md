# Changelog

All notable changes to the MCP Python Executor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2024-03-18

### Added

- Resource management system
  - Memory usage limits and tracking
  - Execution timeouts
  - Concurrent execution limits
- Metrics collection and monitoring
  - Execution statistics (time, memory, success rate)
  - Performance tracking
  - Last execution history
- Health check endpoint
  - Server status monitoring
  - Configuration information
  - Python version detection
  - Real-time metrics
- Structured logging system
  - JSON/text format support
  - Configurable log levels
  - Contextual information
- Enhanced error handling
  - Error categorization
  - Detailed error context
  - Proper cleanup procedures
- Configuration system
  - Environment variable support
  - Default configurations
  - Runtime configuration updates
- Comprehensive documentation
  - README with usage examples
  - API documentation
  - Configuration guide

### Changed

- Improved package management
  - Pre-installed package support
  - Better installation error handling
  - Package version tracking
- Enhanced Python execution
  - Better output capture
  - Resource cleanup
  - Error reporting
- Updated TypeScript configuration
  - ES modules support
  - Strict type checking
  - Better module resolution

### Fixed

- Memory leaks in long-running scripts
- Temporary file cleanup issues
- Package installation error handling
- Concurrent execution management

## [0.1.0] - 2024-03-17

### Added

- Initial release
- Basic Python code execution
- Package installation support
- Simple error handling
- Basic file management
- Command-line interface

### Features

- Execute Python scripts
- Install Python packages
- Capture script output
- Basic error reporting
- Temporary file handling
