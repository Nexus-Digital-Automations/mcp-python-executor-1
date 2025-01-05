# Changelog

All notable changes to the MCP Python Executor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Temporary Directory Management
  - Configurable temp directory location
  - Automatic cleanup of old files
  - Proper permission handling
  - Isolated execution environment

- Timeout Configuration
  - Increased default timeout to 5 minutes
  - Separate package installation timeout (10 minutes)
  - Configurable through environment variables

- Python Environment Verification
  - Minimum Python version requirement (3.9.0)
  - Version check before execution
  - Clear error messages for version mismatches

- Virtual Environment Support
  - Automatic virtual environment creation
  - Configurable venv path
  - Package isolation
  - Environment reuse

- Enhanced Package Installation
  - Virtual environment support
  - Timeout handling
  - Better error reporting
  - Dependency resolution

### Security

- Regular security updates and dependency patches
  - Isolated package installations
  - Virtual environment usage
  - Timeout enforcement

## [0.2.0] - 2024-03-18

### Added

- Configuration System
  - Environment variable support for all settings
  - Default configuration with overrides
  - Python version and package configuration
  - Execution limits configuration
  - Logging configuration

- Resource Management
  - Memory usage limits (configurable, default 512MB)
  - Execution timeouts (configurable, default 30s)
  - Concurrent execution limits (configurable, default 5)
  - Resource cleanup on script completion

- Metrics Collection
  - Execution time tracking
  - Memory usage monitoring
  - Success/failure rates
  - Historical execution data
  - Performance statistics

- Health Check System
  - Server status monitoring
  - Python version detection
  - Real-time metrics reporting
  - Configuration information
  - Active executions tracking

- Structured Logging
  - Multiple log levels (debug, info, error)
  - JSON/text format support
  - Contextual information
  - Operation tracking
  - Error details

- Enhanced Error Handling
  - Custom error types
  - Error categorization
  - Detailed error context
  - Stack trace preservation
  - Cleanup procedures

### Changed

- Package Management
  - Added pre-installed package support
  - Improved installation error handling
  - Package version tracking
  - Better dependency resolution

- Python Execution
  - Enhanced output capture
  - Better resource management
  - Improved error reporting
  - Timeout handling
  - Memory tracking

- Project Structure
  - Modular code organization
  - TypeScript strict mode
  - ES modules support
  - Better type definitions

### Fixed

- Memory leaks in long-running scripts
- Temporary file cleanup issues
- Package installation error handling
- Concurrent execution management
- Resource limit enforcement

### Security

- Added execution timeouts
- Memory usage limits
- Concurrent execution limits
- Temporary file isolation
- Error message sanitization

## [0.1.0] - 2024-03-17

### Added

- Initial release with basic functionality
- Python code execution
  - Basic script running
  - Output capture
  - Error handling

- Package Management
  - Basic pip package installation
  - Simple dependency handling

- File Management
  - Temporary file creation
  - Basic cleanup

### Security

- Basic script isolation
- Simple error handling
- File permission management
