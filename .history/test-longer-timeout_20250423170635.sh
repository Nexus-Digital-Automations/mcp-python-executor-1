#!/bin/bash
# Run the Python executor with a longer timeout

# Set the execution timeout to 2 minutes (120,000 ms)
export EXECUTION_TIMEOUT_MS=120000

# Run the executor
node build/index.js 